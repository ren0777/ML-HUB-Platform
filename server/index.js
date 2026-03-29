const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const path = require('path');
const k8s = require('@kubernetes/client-node');
const Docker = require('dockerode');

const app = express();
app.use(express.json());

const PROXY_FALLBACK_TARGET = process.env.PROXY_FALLBACK_TARGET || 'http://127.0.0.1:65535';
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key';
const K8S_ENABLED = process.env.K8S_ENABLED === 'true' || !!process.env.KUBERNETES_SERVICE_HOST;
const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'jhub';
const NOTEBOOK_IMAGE = process.env.NOTEBOOK_IMAGE || 'jupyter-singleuser:dev';
const NOTEBOOK_PORT = parseInt(process.env.NOTEBOOK_PORT || '8888', 10);
const NOTEBOOK_BASE_URL_PREFIX = process.env.NOTEBOOK_BASE_URL_PREFIX || '/jupyter';
const NOTEBOOK_ROOT_DIR = process.env.NOTEBOOK_ROOT_DIR || '/home/jovyan/work';
const DOCKER_NOTEBOOK_NETWORK = process.env.DOCKER_NOTEBOOK_NETWORK || 'colab-clone_default';
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const NOTEBOOK_CPU_REQUEST = process.env.NOTEBOOK_CPU_REQUEST || '250m';
const NOTEBOOK_MEM_REQUEST = process.env.NOTEBOOK_MEM_REQUEST || '512Mi';
const NOTEBOOK_CPU_LIMIT = process.env.NOTEBOOK_CPU_LIMIT || '1';
const NOTEBOOK_MEM_LIMIT = process.env.NOTEBOOK_MEM_LIMIT || '2Gi';
const NOTEBOOK_PVC_SIZE = process.env.NOTEBOOK_PVC_SIZE || '5Gi';
const sessions = new Map();
const users = new Map();
const eventClients = new Map();
let nextEventClientId = 1;

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const notebooksDir = process.env.NOTEBOOKS_DIR || path.join(__dirname, 'notebooks');
const usersFilePath = process.env.USERS_FILE_PATH || path.join(dataDir, 'users.json');

let k8sCoreApi = null;
let k8sAppsApi = null;
let dockerApi = null;

if (K8S_ENABLED) {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api);
  k8sAppsApi = kc.makeApiClient(k8s.AppsV1Api);
} else {
  dockerApi = new Docker({ socketPath: DOCKER_SOCKET_PATH });
}

// Load users from file, or create admin if it doesn't exist
function loadUsers() {
  if (fs.existsSync(usersFilePath)) {
    const data = fs.readFileSync(usersFilePath, 'utf-8');
    const usersArray = JSON.parse(data);
    users.clear();
    if (usersArray.length === 0) {
      // Create a default admin user if the user file is empty
      const hashedPassword = hashPassword('admin');
      users.set('admin', { password: hashedPassword, role: 'admin' });
      saveUsers();
    } else {
      usersArray.forEach(([username, userData]) => {
        users.set(username, userData);
      });
    }
  } else {
    // Create a default admin user if no user file exists
    const hashedPassword = hashPassword('admin');
    users.set('admin', { password: hashedPassword, role: 'admin' });
    saveUsers();
  }
}

// Save users to file
function saveUsers() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const usersArray = Array.from(users.entries());
  fs.writeFileSync(usersFilePath, JSON.stringify(usersArray, null, 2));
}

loadUsers();

// Ensure user notebook directories exist
if (!fs.existsSync(notebooksDir)) {
  fs.mkdirSync(notebooksDir, { recursive: true });
}

// Simple password hashing with SHA256 + salt
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex');
  return `${salt}$${hash}`;
}

function verifyPassword(password, hash) {
  if (!hash || !hash.includes('$')) return false;
  const parts = hash.split('$');
  if (parts.length < 2) return false;
  const salt = parts[0];
  const storedHash = parts[1];
  const computed = crypto.createHash('sha256').update(salt + password).digest('hex');
  return computed === storedHash;
}

function emitEvent(type, payload, options = {}) {
  const message = `data: ${JSON.stringify({ type, payload, ts: Date.now() })}\n\n`;

  for (const client of eventClients.values()) {
    if (options.toRole && client.role !== options.toRole) {
      continue;
    }

    if (options.toUsernames && !options.toUsernames.includes(client.username)) {
      continue;
    }

    try {
      client.res.write(message);
    } catch (err) {
      if (client.heartbeat) {
        clearInterval(client.heartbeat);
      }
      eventClients.delete(client.id);
    }
  }
}

// Auth routes
// Middleware to require admin role
function requiresAdmin(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: 'Missing token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "admin") return res.status(403).json({ message: "Forbidden" });
    req.user = decoded; // Attach user info to request
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
}

function sanitizeName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildResourceName(base, suffix) {
  const maxLength = 63;
  const safeBase = sanitizeName(base) || 'notebook';
  const trimmedBase = safeBase.slice(0, Math.max(1, maxLength - suffix.length - 1));
  return `${trimmedBase}-${suffix}`.replace(/-+$/g, '');
}

function buildNotebookBaseUrl(sessionId) {
  return `/${sessionId}`;
}

function buildPublicBaseUrl(sessionId) {
  return `${NOTEBOOK_BASE_URL_PREFIX}/${sessionId}`;
}

function parseMemoryValueToBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return 0;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)([kmgtpe]i?|b)?$/i);
  if (!match) {
    return 0;
  }

  const amount = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers = {
    b: 1,
    k: 1000,
    kb: 1000,
    ki: 1024,
    kib: 1024,
    m: 1000 ** 2,
    mb: 1000 ** 2,
    mi: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1000 ** 3,
    gb: 1000 ** 3,
    gi: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1000 ** 4,
    tb: 1000 ** 4,
    ti: 1024 ** 4,
    tib: 1024 ** 4,
    p: 1000 ** 5,
    pb: 1000 ** 5,
    pi: 1024 ** 5,
    pib: 1024 ** 5,
    e: 1000 ** 6,
    eb: 1000 ** 6,
    ei: 1024 ** 6,
    eib: 1024 ** 6,
  };

  return Math.round(amount * (multipliers[unit] || 1));
}

function buildUsageSnapshot(totalBytes, usedBytes) {
  const safeTotal = Math.max(0, Number(totalBytes) || 0);
  const boundedUsed = Math.min(Math.max(0, Number(usedBytes) || 0), safeTotal || Number(usedBytes) || 0);
  const freeBytes = Math.max(0, safeTotal - boundedUsed);
  const usagePercent = safeTotal > 0 ? Number(((boundedUsed / safeTotal) * 100).toFixed(1)) : 0;

  return {
    totalBytes: safeTotal,
    usedBytes: boundedUsed,
    freeBytes,
    usagePercent,
  };
}

async function getFilesystemUsage(targetPath) {
  if (typeof fs.promises.statfs !== 'function') {
    return null;
  }

  try {
    const stats = await fs.promises.statfs(targetPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const totalBytes = blockSize * Number(stats.blocks || 0);
    const freeBytes = blockSize * Number(stats.bavail || stats.bfree || 0);
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    return {
      path: targetPath,
      ...buildUsageSnapshot(totalBytes, usedBytes),
    };
  } catch (err) {
    return null;
  }
}

async function getAdminAnalytics() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const processMemory = process.memoryUsage();
  const configuredPerSessionLimitBytes = parseMemoryValueToBytes(NOTEBOOK_MEM_LIMIT);
  const reservedBytes = configuredPerSessionLimitBytes * sessions.size;
  const storage = await getFilesystemUsage(dataDir);

  return {
    generatedAt: Date.now(),
    hostMemory: buildUsageSnapshot(totalBytes, totalBytes - freeBytes),
    processMemory: {
      rssBytes: processMemory.rss,
      heapTotalBytes: processMemory.heapTotal,
      heapUsedBytes: processMemory.heapUsed,
      externalBytes: processMemory.external,
      arrayBuffersBytes: processMemory.arrayBuffers,
    },
    sessionCapacity: {
      activeSessions: sessions.size,
      configuredPerSessionLimitBytes,
      reservedBytes,
    },
    storage,
  };
}

async function getDockerContainerMemoryUsage(containerName) {
  if (!containerName) {
    return buildUsageSnapshot(0, 0);
  }

  try {
    const container = dockerApi.getContainer(containerName);
    const stats = await container.stats({ stream: false });
    const usage = Number(stats?.memory_stats?.usage || 0);
    const limit = Number(stats?.memory_stats?.limit || 0);
    return buildUsageSnapshot(limit, usage);
  } catch (err) {
    return buildUsageSnapshot(0, 0);
  }
}

async function getDockerVolumeUsage(volumeName) {
  if (!volumeName) {
    return null;
  }

  try {
    const volume = await dockerApi.getVolume(volumeName).inspect();
    const size = Number(volume?.UsageData?.Size);
    const refCount = Number(volume?.UsageData?.RefCount);

    if (Number.isFinite(size) && size >= 0) {
      return {
        mode: 'docker-volume',
        volumeName,
        usedBytes: size,
        refCount: Number.isFinite(refCount) ? refCount : null,
      };
    }

    return {
      mode: 'docker-volume',
      volumeName,
      usedBytes: null,
      refCount: Number.isFinite(refCount) ? refCount : null,
      message: 'Volume size metrics are unavailable from Docker in this environment.',
    };
  } catch (err) {
    if (err?.statusCode === 404) {
      return null;
    }

    return {
      mode: 'docker-volume',
      volumeName,
      usedBytes: null,
      message: 'Failed to inspect Docker volume usage.',
    };
  }
}

async function getK8sPvcUsage(username) {
  const pvcName = buildResourceName(`nb-${username}`, 'pvc');
  try {
    const response = await k8sCoreApi.readNamespacedPersistentVolumeClaim(pvcName, K8S_NAMESPACE);
    const requestedSize = response?.body?.spec?.resources?.requests?.storage;
    return {
      mode: 'k8s-pvc',
      pvcName,
      requestedBytes: parseMemoryValueToBytes(requestedSize),
      usedBytes: null,
      message: 'PVC usage bytes require cluster metrics integration.',
    };
  } catch (err) {
    if (err?.response?.statusCode === 404) {
      return null;
    }

    return {
      mode: 'k8s-pvc',
      pvcName,
      requestedBytes: 0,
      usedBytes: null,
      message: 'Failed to inspect PVC usage.',
    };
  }
}

async function getPerUserResourceUsage(username) {
  const sessionEntry = findSessionEntryByUser(username);
  const activeSession = sessionEntry?.session || null;
  const mode = activeSession?.mode || (K8S_ENABLED ? 'k8s' : 'docker');

  let memory = buildUsageSnapshot(0, 0);
  if (activeSession?.mode === 'docker') {
    memory = await getDockerContainerMemoryUsage(activeSession.containerName);
  } else if (activeSession?.mode === 'k8s') {
    const limitBytes = parseMemoryValueToBytes(NOTEBOOK_MEM_LIMIT);
    memory = buildUsageSnapshot(limitBytes, 0);
  }

  let storage = null;
  if (K8S_ENABLED) {
    storage = await getK8sPvcUsage(username);
  } else {
    const volumeName = activeSession?.volumeName || buildResourceName(`nb-${username}`, 'vol');
    storage = await getDockerVolumeUsage(volumeName);
  }

  return {
    username,
    active: !!activeSession,
    sessionToken: sessionEntry?.sessionId || null,
    mode,
    memory,
    storage,
    updatedAt: Date.now(),
  };
}

async function getAllUsersResourceUsage() {
  const usernames = Array.from(users.keys()).sort((left, right) => left.localeCompare(right));
  const items = await Promise.all(
    usernames.map(async (username) => {
      try {
        return await getPerUserResourceUsage(username);
      } catch (err) {
        return {
          username,
          active: false,
          sessionToken: null,
          mode: K8S_ENABLED ? 'k8s' : 'docker',
          memory: buildUsageSnapshot(0, 0),
          storage: {
            mode: K8S_ENABLED ? 'k8s-pvc' : 'docker-volume',
            usedBytes: null,
            message: err?.message || 'Failed to load usage data.',
          },
          updatedAt: Date.now(),
        };
      }
    })
  );

  return items;
}

function buildNotebookStartCommand() {
  return ['/usr/local/bin/mlhub-start.sh'];
}

function buildEnvMap(env = []) {
  return new Map(
    env
      .map((entry) => entry.split('='))
      .filter(([key]) => !!key)
      .map(([key, ...rest]) => [key, rest.join('=')])
  );
}

function isCompatibleDockerNotebookContainer(inspect) {
  const env = buildEnvMap(inspect?.Config?.Env || []);
  const hasExpectedRootDir = env.get('NOTEBOOK_ROOT_DIR') === NOTEBOOK_ROOT_DIR;
  const hasExpectedMount = (inspect?.Mounts || []).some((mount) => mount.Destination === NOTEBOOK_ROOT_DIR);
  const startsAsRoot = !inspect?.Config?.User || inspect.Config.User === '0';

  return hasExpectedRootDir && hasExpectedMount && startsAsRoot;
}

async function removeDockerNotebookContainer(containerName) {
  const container = dockerApi.getContainer(containerName);

  try {
    await container.stop({ t: 5 });
  } catch (err) {
    if (err?.statusCode !== 304 && err?.statusCode !== 404) {
      throw err;
    }
  }

  try {
    await container.remove({ force: true });
  } catch (err) {
    if (err?.statusCode !== 404) {
      throw err;
    }
  }
}

function buildDockerSessionRecord(sessionId, username, containerName, createdAt = Date.now()) {
  return {
    user: username,
    created: createdAt,
    mode: 'docker',
    containerName,
    volumeName: buildResourceName(`nb-${username}`, 'vol'),
    baseUrl: buildNotebookBaseUrl(sessionId),
    target: `http://${containerName}:${NOTEBOOK_PORT}`,
  };
}

function findSessionEntryByUser(username) {
  for (const [sessionId, session] of sessions.entries()) {
    if (session.user === username) {
      return { sessionId, session };
    }
  }

  return null;
}

async function ensureDockerSessionAvailable(sessionId, session) {
  const container = dockerApi.getContainer(session.containerName);
  const inspect = await container.inspect();

  if (!isCompatibleDockerNotebookContainer(inspect)) {
    await removeDockerNotebookContainer(session.containerName);
    throw new Error('Legacy notebook container removed for migration');
  }

  if (!inspect?.State?.Running) {
    await container.start();
  }

  await waitForNotebookReady(session.target, session.baseUrl);
  return { sessionId, session };
}

async function findReusableDockerSession(username) {
  const existingEntry = findSessionEntryByUser(username);
  if (existingEntry?.session?.mode === 'docker') {
    try {
      return await ensureDockerSessionAvailable(existingEntry.sessionId, existingEntry.session);
    } catch (err) {
      if (err?.statusCode !== 404 && err?.message !== 'Legacy notebook container removed for migration') {
        throw err;
      }

      sessions.delete(existingEntry.sessionId);
    }
  }

  const containers = await dockerApi.listContainers({
    all: true,
    filters: {
      label: ['app=colab-notebook', `username=${sanitizeName(username)}`],
    },
  });

  if (containers.length === 0) {
    return null;
  }

  const sortedContainers = containers.sort((left, right) => {
    const statePriority = (container) => (container.State === 'running' ? 1 : 0);
    return statePriority(right) - statePriority(left) || (right.Created || 0) - (left.Created || 0);
  });

  for (const containerSummary of sortedContainers) {
    const sessionId = containerSummary.Labels?.sessionId;
    const containerName = containerSummary.Names?.[0]?.replace(/^\//, '');

    if (!sessionId || !containerName) {
      continue;
    }

    const inspect = await dockerApi.getContainer(containerName).inspect();
    if (!isCompatibleDockerNotebookContainer(inspect)) {
      await removeDockerNotebookContainer(containerName);
      continue;
    }

    const session = buildDockerSessionRecord(
      sessionId,
      username,
      containerName,
      containerSummary.Created ? containerSummary.Created * 1000 : Date.now()
    );

    sessions.set(sessionId, session);
    return ensureDockerSessionAvailable(sessionId, session);
  }

  return null;
}

function getSessionIdFromRequest(req) {
  const sourceUrl = req.originalUrl || req.url || '';
  const pathOnly = sourceUrl.split('?')[0];
  const parts = pathOnly.split('/').filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  // Handles both:
  // - original URL style: /jupyter/<sessionId>/lab
  // - mounted URL style:  /<sessionId>/lab
  if (parts[0] === 'jupyter') {
    return parts[1] || null;
  }

  return parts[0] || null;
}

async function waitForNotebookReady(target, baseUrl, timeoutMs = 60000) {
  const startedAt = Date.now();
  const readinessUrl = `${target}${baseUrl}/lab`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(readinessUrl, { method: 'GET' });
      if (response.ok || response.status === 302 || response.status === 403) {
        return;
      }
    } catch (err) {
      // Keep retrying until timeout while container boots.
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Notebook did not become ready in time: ${readinessUrl}`);
}

async function ensureUserPvc(username) {
  const pvcName = buildResourceName(`nb-${username}`, 'pvc');
  try {
    await k8sCoreApi.readNamespacedPersistentVolumeClaim(pvcName, K8S_NAMESPACE);
    return pvcName;
  } catch (err) {
    if (err?.response?.statusCode !== 404) {
      throw err;
    }
  }

  const pvcSpec = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: pvcName,
      namespace: K8S_NAMESPACE,
      labels: {
        app: 'colab-notebook',
        username: sanitizeName(username),
      },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: {
        requests: {
          storage: NOTEBOOK_PVC_SIZE,
        },
      },
    },
  };

  try {
    await k8sCoreApi.createNamespacedPersistentVolumeClaim(K8S_NAMESPACE, pvcSpec);
  } catch (err) {
    if (err?.response?.statusCode !== 409) {
      throw err;
    }
  }

  return pvcName;
}

async function createNotebookResources(sessionId, username) {
  const baseName = sanitizeName(`nb-${username}-${sessionId.slice(0, 6)}`) || `nb-${sessionId.slice(0, 6)}`;
  const deploymentName = buildResourceName(baseName, 'dep');
  const serviceName = buildResourceName(baseName, 'svc');
  const pvcName = await ensureUserPvc(username);
  const notebookBaseUrl = buildNotebookBaseUrl(sessionId);
  const publicBaseUrl = buildPublicBaseUrl(sessionId);

  const deploymentSpec = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: deploymentName,
      namespace: K8S_NAMESPACE,
      labels: {
        app: 'colab-notebook',
        sessionId,
        username: sanitizeName(username),
      },
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          app: 'colab-notebook',
          sessionId,
        },
      },
      template: {
        metadata: {
          labels: {
            app: 'colab-notebook',
            sessionId,
            username: sanitizeName(username),
          },
        },
        spec: {
          securityContext: {
            fsGroup: 100,
          },
          containers: [
            {
              name: 'notebook',
              image: NOTEBOOK_IMAGE,
              ports: [{ containerPort: NOTEBOOK_PORT }],
              env: [
                { name: 'NOTEBOOK_BASE_URL', value: notebookBaseUrl },
                { name: 'NOTEBOOK_PORT', value: String(NOTEBOOK_PORT) },
                { name: 'NOTEBOOK_ROOT_DIR', value: NOTEBOOK_ROOT_DIR },
              ],
              resources: {
                requests: {
                  cpu: NOTEBOOK_CPU_REQUEST,
                  memory: NOTEBOOK_MEM_REQUEST,
                },
                limits: {
                  cpu: NOTEBOOK_CPU_LIMIT,
                  memory: NOTEBOOK_MEM_LIMIT,
                },
              },
              volumeMounts: [
                {
                  name: 'notebooks',
                  mountPath: NOTEBOOK_ROOT_DIR,
                },
              ],
              command: buildNotebookStartCommand(),
              securityContext: {
                runAsUser: 0,
                runAsGroup: 0,
              },
            },
          ],
          volumes: [
            {
              name: 'notebooks',
              persistentVolumeClaim: {
                claimName: pvcName,
              },
            },
          ],
        },
      },
    },
  };

  const serviceSpec = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: serviceName,
      namespace: K8S_NAMESPACE,
      labels: {
        app: 'colab-notebook',
        sessionId,
        username: sanitizeName(username),
      },
    },
    spec: {
      selector: {
        app: 'colab-notebook',
        sessionId,
      },
      ports: [
        {
          port: NOTEBOOK_PORT,
          targetPort: NOTEBOOK_PORT,
        },
      ],
      type: 'ClusterIP',
    },
  };

  await k8sAppsApi.createNamespacedDeployment(K8S_NAMESPACE, deploymentSpec);
  await k8sCoreApi.createNamespacedService(K8S_NAMESPACE, serviceSpec);

  return {
    deploymentName,
    serviceName,
    pvcName,
    notebookBaseUrl,
    publicBaseUrl,
  };
}

async function ensureDockerVolume(volumeName) {
  try {
    await dockerApi.getVolume(volumeName).inspect();
    return;
  } catch (err) {
    if (err?.statusCode !== 404) {
      throw err;
    }
  }

  await dockerApi.createVolume({
    Name: volumeName,
    Labels: {
      app: 'colab-notebook',
    },
  });
}

async function createDockerNotebookResources(sessionId, username) {
  const containerName = buildResourceName(`nb-${username}-${sessionId.slice(0, 8)}`, 'ctr');
  const volumeName = buildResourceName(`nb-${username}`, 'vol');
  const notebookBaseUrl = buildNotebookBaseUrl(sessionId);
  const publicBaseUrl = buildPublicBaseUrl(sessionId);

  await ensureDockerVolume(volumeName);

  const container = await dockerApi.createContainer({
    name: containerName,
    Image: NOTEBOOK_IMAGE,
    User: '0',
    Entrypoint: buildNotebookStartCommand(),
    Env: [
      `NOTEBOOK_BASE_URL=${notebookBaseUrl}`,
      `NOTEBOOK_PORT=${NOTEBOOK_PORT}`,
      `NOTEBOOK_ROOT_DIR=${NOTEBOOK_ROOT_DIR}`,
    ],
    ExposedPorts: {
      [`${NOTEBOOK_PORT}/tcp`]: {},
    },
    HostConfig: {
      NetworkMode: DOCKER_NOTEBOOK_NETWORK,
      Binds: [`${volumeName}:${NOTEBOOK_ROOT_DIR}`],
      RestartPolicy: {
        Name: 'unless-stopped',
      },
    },
    Labels: {
      app: 'colab-notebook',
      sessionId,
      username: sanitizeName(username),
    },
  });

  await container.start();

  return {
    containerName,
    volumeName,
    notebookBaseUrl,
    publicBaseUrl,
    target: `http://${containerName}:${NOTEBOOK_PORT}`,
  };
}

async function deleteNotebookResources(session) {
  if (!session) {
    return;
  }

  if (session.mode === 'docker' && session.containerName) {
    try {
      const container = dockerApi.getContainer(session.containerName);
      await container.stop({ t: 5 });
    } catch (err) {
      if (err?.statusCode !== 304 && err?.statusCode !== 404) {
        throw err;
      }
    }

    try {
      const container = dockerApi.getContainer(session.containerName);
      await container.remove({ force: true });
    } catch (err) {
      if (err?.statusCode !== 404) {
        throw err;
      }
    }

    return;
  }

  if (!session.serviceName || !session.deploymentName) {
    return;
  }

  try {
    await k8sAppsApi.deleteNamespacedDeployment(session.deploymentName, K8S_NAMESPACE);
  } catch (err) {
    if (err?.response?.statusCode !== 404) {
      throw err;
    }
  }

  try {
    await k8sCoreApi.deleteNamespacedService(session.serviceName, K8S_NAMESPACE);
  } catch (err) {
    if (err?.response?.statusCode !== 404) {
      throw err;
    }
  }
}

app.post('/auth/signup', (req, res) => {
  const { username, password } = req.body;
  if (users.has(username)) {
    return res.status(400).json({ message: 'User already exists' });
  }
  const hashedPassword = hashPassword(password);
  const userObject = { password: hashedPassword, role: "user" }; // Default role
  if (username === "admin") { // Assign admin role for "admin" user
    userObject.role = "admin";
  }
  users.set(username, userObject);
  saveUsers(); // Save users after signup

  // Create a directory for the user's notebooks
  const userNotebooksDir = path.join(notebooksDir, username);
  if (!fs.existsSync(userNotebooksDir)) {
    fs.mkdirSync(userNotebooksDir);
  }

  const token = jwt.sign({ username, role: userObject.role }, JWT_SECRET, { expiresIn: '7d' }); // Include role in token
  emitEvent('user_added', { username, role: userObject.role }, { toRole: 'admin' });
  res.json({ token });
});

app.post('/auth/login', (req, res) => {
  console.log('Login request received:', req.body);
  const { username, password } = req.body;
  const user = users.get(username);
  console.log('User from map:', user);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const token = jwt.sign({ username, role: user.role }, JWT_SECRET, { expiresIn: '7d' }); // Include role in token
  res.json({ token });
});

app.get('/events', (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== 'string') {
    return res.status(401).json({ message: 'Missing token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const clientId = String(nextEventClientId++);
  const client = {
    id: clientId,
    username: decoded.username,
    role: decoded.role,
    res,
    heartbeat: null,
  };

  client.heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      clearInterval(client.heartbeat);
      eventClients.delete(clientId);
    }
  }, 25000);

  eventClients.set(clientId, client);

  res.write(`data: ${JSON.stringify({ type: 'connected', payload: { username: decoded.username, role: decoded.role }, ts: Date.now() })}\n\n`);

  req.on('close', () => {
    if (client.heartbeat) {
      clearInterval(client.heartbeat);
    }
    eventClients.delete(clientId);
  });
});

// API route
app.post('/session/new', async (req, res) => {
  const { token } = req.body;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = decoded.username; // Use username from decoded token

    const existingEntry = findSessionEntryByUser(user);
    if (existingEntry) {
      try {
        if (existingEntry.session.mode === 'docker') {
          await ensureDockerSessionAvailable(existingEntry.sessionId, existingEntry.session);
        }

        return res.json({
          sessionToken: existingEntry.sessionId,
          jupyterBase: buildPublicBaseUrl(existingEntry.sessionId),
        });
      } catch (err) {
        sessions.delete(existingEntry.sessionId);

        if (existingEntry.session.mode !== 'docker') {
          throw err;
        }
      }
    }

    if (!K8S_ENABLED) {
      const restoredSession = await findReusableDockerSession(user);
      if (restoredSession) {
        return res.json({
          sessionToken: restoredSession.sessionId,
          jupyterBase: buildPublicBaseUrl(restoredSession.sessionId),
        });
      }
    }

    const proxyToken = crypto.randomBytes(16).toString('hex'); // Generate a random session ID

    if (K8S_ENABLED) {
      const { deploymentName, serviceName, notebookBaseUrl, publicBaseUrl } = await createNotebookResources(proxyToken, user);
      const target = `http://${serviceName}.${K8S_NAMESPACE}.svc.cluster.local:${NOTEBOOK_PORT}`;

      await waitForNotebookReady(target, notebookBaseUrl);

      sessions.set(proxyToken, {
        user,
        created: Date.now(),
        mode: 'k8s',
        deploymentName,
        serviceName,
        baseUrl: notebookBaseUrl,
        target,
      });
      emitEvent('session_started', { sessionToken: proxyToken, user, mode: 'k8s' }, { toRole: 'admin' });
      emitEvent('session_started', { sessionToken: proxyToken, user, mode: 'k8s' }, { toUsernames: [user] });
      return res.json({ sessionToken: proxyToken, jupyterBase: publicBaseUrl });

      return;
    }

    const { containerName, volumeName, notebookBaseUrl, publicBaseUrl, target } = await createDockerNotebookResources(proxyToken, user);
    try {
      await waitForNotebookReady(target, notebookBaseUrl);
    } catch (err) {
      await deleteNotebookResources({ mode: 'docker', containerName });
      throw err;
    }

    sessions.set(proxyToken, {
      user,
      created: Date.now(),
      mode: 'docker',
      containerName,
      volumeName,
      baseUrl: notebookBaseUrl,
      target,
    });
    emitEvent('session_started', { sessionToken: proxyToken, user, mode: 'docker' }, { toRole: 'admin' });
    emitEvent('session_started', { sessionToken: proxyToken, user, mode: 'docker' }, { toUsernames: [user] });
    res.json({ sessionToken: proxyToken, jupyterBase: publicBaseUrl });
  } catch (err) {
    console.error('Failed to create or restore notebook session:', err);
    if (err?.message === 'Invalid or expired token' || err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    res.status(500).json({ message: err?.message || 'Failed to create or restore notebook session' });
  }
});

app.post('/session/stop', async (req, res) => {
  const { token, sessionToken } = req.body;
  if (!sessionToken) {
    return res.status(400).json({ message: 'Missing session token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const session = sessions.get(sessionToken);
    if (!session) {
      return res.status(404).json({ message: 'Session not found' });
    }

    if (decoded.role !== 'admin' && session.user !== decoded.username) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (session.mode === 'k8s' || session.mode === 'docker') {
      await deleteNotebookResources(session);
    }

    sessions.delete(sessionToken);
    emitEvent(
      'session_stopped',
      { sessionToken, user: session.user, stoppedBy: decoded.username },
      { toRole: 'admin' }
    );
    emitEvent(
      'session_stopped',
      { sessionToken, user: session.user, stoppedBy: decoded.username },
      { toUsernames: [session.user] }
    );
    res.json({ message: 'Session stopped' });
  } catch (err) {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
});

// Admin APIs
app.get("/admin/users", requiresAdmin, (req, res) => {
  // Return users with their roles (excluding passwords)
  const usersWithRoles = Array.from(users.entries()).map(([username, data]) => ({
    username,
    role: data.role
  }));
  res.json(usersWithRoles);
});

app.get("/admin/sessions", requiresAdmin, (req, res) => {
  const serialized = [...sessions.entries()].map(([sessionId, sessionData]) => [
    sessionId,
    {
      user: sessionData.user,
      created: sessionData.created,
      mode: sessionData.mode,
      baseUrl: sessionData.baseUrl,
    },
  ]);
  res.json(serialized);
});

app.get('/admin/analytics', requiresAdmin, async (req, res) => {
  try {
    const analytics = await getAdminAnalytics();
    res.json(analytics);
  } catch (err) {
    console.error('Failed to build admin analytics:', err);
    res.status(500).json({ message: 'Failed to load admin analytics' });
  }
});

app.get('/admin/user-usage', requiresAdmin, async (req, res) => {
  try {
    const requestedUsername = typeof req.query.username === 'string' ? req.query.username.trim() : '';

    if (requestedUsername) {
      if (!users.has(requestedUsername)) {
        return res.status(404).json({ message: 'User not found' });
      }

      const usage = await getPerUserResourceUsage(requestedUsername);
      return res.json({ generatedAt: Date.now(), items: [usage] });
    }

    const items = await getAllUsersResourceUsage();
    res.json({ generatedAt: Date.now(), items });
  } catch (err) {
    console.error('Failed to build per-user usage analytics:', err);
    res.status(500).json({ message: 'Failed to load per-user usage analytics' });
  }
});

// Admin API to create a new user
app.post("/admin/user", requiresAdmin, (req, res) => {
  const { username, password, role = "user" } = req.body; // Default role to 'user'
  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required." });
  }
  if (users.has(username)) {
    return res.status(400).json({ message: "User already exists" });
  }

  const hashedPassword = hashPassword(password);
  users.set(username, { password: hashedPassword, role });
  saveUsers(); // Save users after creating a new user

  // Create a directory for the user's notebooks
  const userNotebooksDir = path.join(notebooksDir, username);
  if (!fs.existsSync(userNotebooksDir)) {
    fs.mkdirSync(userNotebooksDir);
  }

  emitEvent('user_added', { username, role }, { toRole: 'admin' });

  res.status(201).json({ message: `User ${username} created with role ${role}` });
});

app.delete("/admin/user/:username", requiresAdmin, (req, res) => {
  const { username } = req.params;
  if (!users.has(username)) return res.status(404).json({ message: "User not found" });
  // Prevent admin from deleting themselves
  if (req.user.username === username && req.user.role === "admin") {
    return res.status(403).json({ message: "Admin cannot delete their own account." });
  }

  users.delete(username);
  saveUsers(); // Save users after deleting a user
  // Also delete their notebooks directory
  const userNotebooksDir = path.join(notebooksDir, username);
  if (fs.existsSync(userNotebooksDir)) {
    fs.rmSync(userNotebooksDir, { recursive: true, force: true });
  }
  // End any active sessions for the deleted user
  for (let [sessionKey, sessionData] of sessions.entries()) {
    if (sessionData.user === username) {
      emitEvent(
        'session_stopped',
        { sessionToken: sessionKey, user: sessionData.user, stoppedBy: req.user.username },
        { toRole: 'admin' }
      );
      emitEvent(
        'session_stopped',
        { sessionToken: sessionKey, user: sessionData.user, stoppedBy: req.user.username },
        { toUsernames: [sessionData.user] }
      );
      if (sessionData.mode === 'k8s' || sessionData.mode === 'docker') {
        deleteNotebookResources(sessionData).catch((err) => {
          console.error('Failed to cleanup notebook resources for deleted user:', err);
        });
      }
      sessions.delete(sessionKey);
    }
  }
  emitEvent('user_deleted', { username, deletedBy: req.user.username }, { toRole: 'admin' });
  emitEvent('user_deleted', { username, deletedBy: req.user.username }, { toUsernames: [username] });
  res.json({ message: "User and associated data deleted" });
});

// Proxy route
app.use('/jupyter', (req, res, next) => {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ message: 'Session not found' });
  }
  return next();
});

app.use(
  '/jupyter',
  createProxyMiddleware({
    target: PROXY_FALLBACK_TARGET,
    changeOrigin: true,
    ws: true,
    router: (req) => {
      const sessionId = getSessionIdFromRequest(req);
      const session = sessionId ? sessions.get(sessionId) : null;
      return session?.target || PROXY_FALLBACK_TARGET;
    },
    pathRewrite: (path, req) => {
      const fullPath = req.originalUrl || path;
      return fullPath.replace(/^\/jupyter/, '');
    },
  })
);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Backend is running' });
});

// Root diagnostics endpoint
app.get('/', (req, res) => {
  res.send('Backend API is running!');
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`🚀 Session proxy listening on port ${port}`);
  console.log(`Using JWT_SECRET: ${JWT_SECRET}`);
});
