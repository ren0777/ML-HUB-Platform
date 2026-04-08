const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const path = require('path');
const k8s = require('@kubernetes/client-node');
const Docker = require('dockerode');
const nodemailer = require('nodemailer');
const { PassThrough } = require('stream');

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
const otpVerifications = new Map();
let nextEventClientId = 1;

const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const notebooksDir = process.env.NOTEBOOKS_DIR || path.join(__dirname, 'notebooks');
const usersFilePath = process.env.USERS_FILE_PATH || path.join(dataDir, 'users.json');
const COLLEGE_DOMAIN = process.env.COLLEGE_DOMAIN || 'gla.ac.in';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 3;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || '20000', 10);
const MAX_ANALYSIS_SOURCE_LENGTH = parseInt(process.env.MAX_ANALYSIS_SOURCE_LENGTH || '25000', 10);

const QUOTA_MIN_MEMORY_MI = parseInt(process.env.QUOTA_MIN_MEMORY_MI || '512', 10);
const QUOTA_MAX_MEMORY_MI = parseInt(process.env.QUOTA_MAX_MEMORY_MI || '4096', 10);
const QUOTA_DEFAULT_MEMORY_MI = parseInt(process.env.QUOTA_DEFAULT_MEMORY_MI || '1024', 10);
const QUOTA_MEMORY_STEP_MI = parseInt(process.env.QUOTA_MEMORY_STEP_MI || '256', 10);

const QUOTA_MIN_STORAGE_GI = parseInt(process.env.QUOTA_MIN_STORAGE_GI || '5', 10);
const QUOTA_MAX_STORAGE_GI = parseInt(process.env.QUOTA_MAX_STORAGE_GI || '20', 10);
const QUOTA_DEFAULT_STORAGE_GI = parseInt(process.env.QUOTA_DEFAULT_STORAGE_GI || '5', 10);
const QUOTA_STORAGE_STEP_GI = parseInt(process.env.QUOTA_STORAGE_STEP_GI || '1', 10);

let k8sCoreApi = null;
let k8sAppsApi = null;
let dockerApi = null;

function isValidStep(value, min, step) {
  return Number.isInteger((value - min) / step);
}

function validateQuotaInput(memoryMiRaw, storageGiRaw) {
  const memoryMi = Number(memoryMiRaw);
  const storageGi = Number(storageGiRaw);

  if (!Number.isInteger(memoryMi) || !Number.isInteger(storageGi)) {
    return { error: 'Memory and storage must be integer values.' };
  }

  if (memoryMi < QUOTA_MIN_MEMORY_MI || memoryMi > QUOTA_MAX_MEMORY_MI) {
    return {
      error: `Memory must be between ${QUOTA_MIN_MEMORY_MI}Mi and ${QUOTA_MAX_MEMORY_MI}Mi.`,
    };
  }

  if (storageGi < QUOTA_MIN_STORAGE_GI || storageGi > QUOTA_MAX_STORAGE_GI) {
    return {
      error: `Storage must be between ${QUOTA_MIN_STORAGE_GI}Gi and ${QUOTA_MAX_STORAGE_GI}Gi.`,
    };
  }

  if (!isValidStep(memoryMi, QUOTA_MIN_MEMORY_MI, QUOTA_MEMORY_STEP_MI)) {
    return {
      error: `Memory must increase in steps of ${QUOTA_MEMORY_STEP_MI}Mi.`,
    };
  }

  if (!isValidStep(storageGi, QUOTA_MIN_STORAGE_GI, QUOTA_STORAGE_STEP_GI)) {
    return {
      error: `Storage must increase in steps of ${QUOTA_STORAGE_STEP_GI}Gi.`,
    };
  }

  return {
    memoryMi,
    storageGi,
    error: null,
  };
}

function normalizeUserQuota(user) {
  const memoryMi = Number.isInteger(user?.quota?.memoryMi)
    ? Math.min(Math.max(user.quota.memoryMi, QUOTA_MIN_MEMORY_MI), QUOTA_MAX_MEMORY_MI)
    : QUOTA_DEFAULT_MEMORY_MI;
  const storageGi = Number.isInteger(user?.quota?.storageGi)
    ? Math.min(Math.max(user.quota.storageGi, QUOTA_MIN_STORAGE_GI), QUOTA_MAX_STORAGE_GI)
    : QUOTA_DEFAULT_STORAGE_GI;

  return { memoryMi, storageGi };
}

function normalizeUserRecord(userData, options = {}) {
  const normalized = { ...(userData || {}) };
  const isNewUser = options.isNewUser === true;
  const role = normalized.role || 'user';

  const quota = normalizeUserQuota(normalized);
  normalized.quota = quota;

  if (role === 'admin') {
    normalized.quotaSetupComplete = true;
  } else if (typeof normalized.quotaSetupComplete !== 'boolean') {
    normalized.quotaSetupComplete = isNewUser ? false : true;
  }

  return normalized;
}

function buildAuthToken(username, user) {
  const quotaSetupComplete = user?.role === 'admin'
    ? true
    : user?.quotaSetupComplete !== false;

  return jwt.sign(
    {
      username,
      role: user?.role || 'user',
      quotaSetupComplete,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function getEffectiveQuotaForUser(username) {
  const user = users.get(username) || {};
  const { memoryMi, storageGi } = normalizeUserQuota(user);

  return {
    memoryMi,
    storageGi,
    memoryLimit: `${memoryMi}Mi`,
    storageSize: `${storageGi}Gi`,
    memoryLimitBytes: memoryMi * 1024 * 1024,
  };
}

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
    let usersChanged = false;
    if (usersArray.length === 0) {
      // Create a default admin user if the user file is empty
      const hashedPassword = hashPassword('admin');
      users.set('admin', normalizeUserRecord({ password: hashedPassword, role: 'admin' }));
      saveUsers();
    } else {
      usersArray.forEach(([username, userData]) => {
        const normalizedUser = normalizeUserRecord(userData);
        users.set(username, normalizedUser);
        if (JSON.stringify(normalizedUser) !== JSON.stringify(userData)) {
          usersChanged = true;
        }
      });
      if (usersChanged) {
        saveUsers();
      }
    }
  } else {
    // Create a default admin user if no user file exists
    const hashedPassword = hashPassword('admin');
    users.set('admin', normalizeUserRecord({ password: hashedPassword, role: 'admin' }));
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

// Nodemailer transporter setup
let emailTransporter;
if (SMTP_USER && SMTP_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });
}

// OTP helper functions
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

async function sendOtpEmail(email, otp) {
  if (!emailTransporter) {
    console.log(`[DEV MODE] OTP for ${email}: ${otp}`);
    return true;
  }
  try {
    await emailTransporter.sendMail({
      from: SMTP_USER,
      to: email,
      subject: 'MLHub Verification Code',
      text: `Your MLHub OTP is ${otp}. It expires in 5 minutes. Do not share this code with anyone.`,
      html: `
        <div style="margin:0;padding:24px;background:#f7f8fb;font-family:'Segoe UI',Tahoma,sans-serif;color:#1f2937;">
          <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(15,23,42,0.06);">
            <div style="padding:18px 22px;background:linear-gradient(120deg,#f9fafb,#eef2ff);border-bottom:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;letter-spacing:1px;color:#64748b;text-transform:uppercase;">MLHub</p>
              <h2 style="margin:8px 0 0 0;font-size:20px;font-weight:700;color:#111827;">Your login code is here</h2>
            </div>

            <div style="padding:24px 22px;line-height:1.65;">
              <p style="margin:0 0 14px 0;color:#374151;">A calm little check-in from your notebook workspace.</p>
              <p style="margin:0 0 16px 0;color:#374151;">Use this OTP to verify your account:</p>

              <div style="margin:0 0 16px 0;padding:14px 16px;border:1px dashed #cbd5e1;border-radius:10px;background:#f8fafc;text-align:center;">
                <span style="display:inline-block;font-size:34px;letter-spacing:8px;font-weight:700;color:#0f172a;">${otp}</span>
              </div>

              <p style="margin:0 0 6px 0;color:#475569;font-size:14px;">This code expires in <strong>5 minutes</strong>.</p>
              <p style="margin:0;color:#475569;font-size:14px;">For safety, do not share it with anyone.</p>
            </div>

            <div style="padding:14px 22px;border-top:1px solid #e5e7eb;background:#fafafa;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">If you did not request this, you can ignore this email.</p>
            </div>
          </div>
        </div>
      `
    });
    return true;
  } catch (err) {
    console.error('Email send failed:', err);
    return false;
  }
}

// Auth routes
function requiresAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: 'Missing token' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // Attach user info to request
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
}

// Middleware to require admin role
function requiresAdmin(req, res, next) {
  requiresAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    return next();
  });
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

function getUserStorageQuotaBytes(username) {
  if (!username) {
    return 0;
  }

  const quota = getEffectiveQuotaForUser(username);
  return quota.storageGi * (1024 ** 3);
}

async function getDockerContainerWritableUsage(containerName) {
  if (!containerName) {
    return null;
  }

  try {
    const container = dockerApi.getContainer(containerName);
    const inspect = await container.inspect({ size: true });
    const sizeRw = Number(inspect?.SizeRw);
    return Number.isFinite(sizeRw) && sizeRw >= 0 ? sizeRw : null;
  } catch (err) {
    return null;
  }
}

async function getDockerVolumeUsage(volumeName, username) {
  if (!volumeName) {
    return null;
  }

  const requestedBytes = getUserStorageQuotaBytes(username);

  try {
    const volume = await dockerApi.getVolume(volumeName).inspect();
    const size = Number(volume?.UsageData?.Size);
    const refCount = Number(volume?.UsageData?.RefCount);

    if (Number.isFinite(size) && size >= 0) {
      return {
        mode: 'docker-volume',
        volumeName,
        usedBytes: size,
        requestedBytes,
        refCount: Number.isFinite(refCount) ? refCount : null,
      };
    }

    return {
      mode: 'docker-volume',
      volumeName,
      usedBytes: null,
      requestedBytes,
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
      requestedBytes,
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
    storage = await getDockerVolumeUsage(volumeName, username);

    const writableLayerUsedBytes = await getDockerContainerWritableUsage(activeSession?.containerName);
    const volumeUsedBytes = Number.isFinite(storage?.usedBytes) ? storage.usedBytes : null;
    const combinedParts = [volumeUsedBytes, writableLayerUsedBytes].filter(
      (value) => Number.isFinite(value) && value >= 0
    );
    const combinedUsedBytes = combinedParts.length > 0
      ? combinedParts.reduce((sum, value) => sum + value, 0)
      : null;

    storage = {
      ...(storage || {
        mode: 'docker-volume',
        volumeName,
        requestedBytes: getUserStorageQuotaBytes(username),
      }),
      usedBytes: combinedUsedBytes,
      volumeUsedBytes,
      writableLayerUsedBytes,
      message: storage?.message || null,
    };

    if (storage?.message && writableLayerUsedBytes !== null) {
      storage.message = `${storage.message} Showing writable-layer usage in the meantime.`;
    }
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

function resolveSafeNotebookPath(username, notebookPath = '') {
  const userRoot = path.resolve(path.join(notebooksDir, username));
  const targetPath = path.resolve(path.join(userRoot, notebookPath));

  if (!targetPath.startsWith(userRoot)) {
    throw new Error('Invalid notebook path');
  }

  return { userRoot, targetPath };
}

async function listLocalNotebookFilesForUser(username) {
  const { userRoot } = resolveSafeNotebookPath(username);
  if (!fs.existsSync(userRoot)) {
    return [];
  }

  const notebooks = [];
  const stack = [''];

  while (stack.length > 0) {
    const relDir = stack.pop();
    const currentPath = path.join(userRoot, relDir);
    const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const nextRel = relDir ? path.join(relDir, entry.name) : entry.name;
      const posixRel = nextRel.split(path.sep).join('/');

      if (entry.isDirectory()) {
        stack.push(nextRel);
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ipynb')) {
        continue;
      }

      const stats = await fs.promises.stat(path.join(userRoot, nextRel));
      notebooks.push({
        id: Buffer.from(`${username}:local:${posixRel}`).toString('base64url'),
        username,
        source: 'local',
        notebookPath: posixRel,
        name: entry.name,
        sizeBytes: stats.size,
        updatedAt: stats.mtimeMs,
      });
    }
  }

  return notebooks.sort((left, right) => right.updatedAt - left.updatedAt);
}

async function fetchLiveNotebookDirectory(session, relativePath = '') {
  const encodedSegments = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment));
  const routePath = encodedSegments.length > 0 ? `/${encodedSegments.join('/')}` : '';
  const url = `${session.target}${session.baseUrl}/api/contents${routePath}?content=1`;

  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Failed to fetch notebook listing from Jupyter: ${response.status}`);
  }

  return response.json();
}

async function listLiveNotebookFilesForUser(username) {
  const sessionEntry = findSessionEntryByUser(username);
  if (!sessionEntry?.session) {
    return [];
  }

  const queue = [''];
  const notebooks = [];

  while (queue.length > 0) {
    const rel = queue.shift();
    const payload = await fetchLiveNotebookDirectory(sessionEntry.session, rel);
    const content = Array.isArray(payload?.content) ? payload.content : [];

    for (const item of content) {
      const itemPath = typeof item?.path === 'string' ? item.path : '';
      if (!itemPath) {
        continue;
      }

      if (item?.type === 'directory') {
        queue.push(itemPath);
        continue;
      }

      if (item?.type !== 'notebook') {
        continue;
      }

      notebooks.push({
        id: Buffer.from(`${username}:live:${itemPath}`).toString('base64url'),
        username,
        source: 'live',
        notebookPath: itemPath,
        name: path.basename(itemPath),
        sizeBytes: Number(item?.size) || 0,
        updatedAt: item?.last_modified ? new Date(item.last_modified).getTime() : Date.now(),
      });
    }
  }

  return notebooks.sort((left, right) => right.updatedAt - left.updatedAt);
}

function collectQuickHint(stderr = '', stdout = '') {
  const combined = `${stderr}\n${stdout}`.toLowerCase();

  if (combined.includes('assert')) {
    return 'At least one assertion failed. Check expected output and edge-case handling in your function.';
  }

  if (combined.includes('syntaxerror')) {
    return 'There is a syntax error. Verify indentation, colons, and unmatched brackets in your Python code.';
  }

  if (combined.includes('modulenotfounderror')) {
    return 'A required module is missing. Install/import dependencies or adjust your test imports.';
  }

  if (combined.includes('nameerror')) {
    return 'A variable or function name is not defined. Double-check naming consistency and scope.';
  }

  return 'Tests failed. Start by fixing the first visible error and rerun until all tests pass.';
}

async function runDockerExec(containerName, command, env = [], timeoutMs = 20000) {
  const container = dockerApi.getContainer(containerName);
  const exec = await container.exec({
    Cmd: ['bash', '-lc', command],
    AttachStdout: true,
    AttachStderr: true,
    Env: env,
    Tty: false,
  });

  const stream = await exec.start({ hijack: true, stdin: false });
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  let stdout = '';
  let stderr = '';

  stdoutStream.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  stderrStream.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  dockerApi.modem.demuxStream(stream, stdoutStream, stderrStream);

  const timeoutId = setTimeout(() => {
    try {
      stream.destroy(new Error('Execution timed out'));
    } catch (err) {
      // Ignore stream teardown errors.
    }
  }, timeoutMs);

  try {
    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const inspect = await exec.inspect();
  return {
    exitCode: Number.isFinite(inspect?.ExitCode) ? inspect.ExitCode : 1,
    stdout,
    stderr,
  };
}

async function runPythonSubmissionChecks(user, sourceCode, testCode = '') {
  const sessionEntry = findSessionEntryByUser(user);
  if (!sessionEntry?.session || sessionEntry.session.mode !== 'docker') {
    throw new Error('Start a notebook session first to run code analysis checks.');
  }

  const safeCode = String(sourceCode || '').slice(0, MAX_ANALYSIS_SOURCE_LENGTH);
  const safeTests = String(testCode || '').slice(0, MAX_ANALYSIS_SOURCE_LENGTH);
  const encodedCode = Buffer.from(safeCode, 'utf8').toString('base64');
  const encodedTests = Buffer.from(safeTests, 'utf8').toString('base64');
  const hasTests = safeTests.trim().length > 0;
  const script = [
    'set -e',
    'WORKDIR=/home/jovyan/work/.mlhub-review',
    'mkdir -p "$WORKDIR"',
    'echo "$MLHUB_CODE_B64" | base64 -d > "$WORKDIR/submission.py"',
    'if [ -n "$MLHUB_TEST_B64" ]; then echo "$MLHUB_TEST_B64" | base64 -d > "$WORKDIR/test_submission.py"; fi',
    'python -m py_compile "$WORKDIR/submission.py"',
    hasTests ? 'python -m pytest -q "$WORKDIR/test_submission.py"' : 'python "$WORKDIR/submission.py"',
  ].join(' && ');

  return runDockerExec(
    sessionEntry.session.containerName,
    script,
    [`MLHUB_CODE_B64=${encodedCode}`, `MLHUB_TEST_B64=${encodedTests}`],
    25000
  );
}

function normalizeCoachingMode(rawMode) {
  const mode = String(rawMode || 'full').toLowerCase();
  if (mode === 'hint' || mode === 'step' || mode === 'full') {
    return mode;
  }
  return 'full';
}

async function callGeminiForFeedback({ code, tests, execution, coachingMode = 'full' }) {
  if (!GEMINI_API_KEY) {
    return {
      explanation: 'Gemini API key is not configured. Set GEMINI_API_KEY to enable AI explanations.',
      suggestions: ['Configure GEMINI_API_KEY and retry analysis.'],
    };
  }

  const mode = normalizeCoachingMode(coachingMode);
  const modeInstructions = {
    hint: [
      'COACHING MODE: HINT ONLY.',
      'Do not provide full solution steps.',
      'Give a short directional hint and up to 2 concise suggestions.',
      'Keep explanation under 2 short sentences.',
    ],
    step: [
      'COACHING MODE: STEP-BY-STEP.',
      'Provide a numbered sequence of concrete debugging/fix steps.',
      'Keep it focused and actionable.',
      'Return 3 to 6 suggestions where each is a single step.',
    ],
    full: [
      'COACHING MODE: FULL EXPLANATION.',
      'Explain the root cause, what is wrong, and exactly how to fix it.',
      'Include important edge cases and implementation notes when useful.',
      'Return up to 6 suggestions with practical corrections.',
    ],
  };

  const prompt = [
    'You are a strict coding coach.',
    'Given the execution result below, explain the first wrong part clearly and suggest concrete corrections.',
    'Return valid JSON only: {"explanation":"...","suggestions":["...","..."]}.',
    ...modeInstructions[mode],
    '',
    'SUBMISSION:',
    code.slice(0, 6000),
    '',
    'TESTS:',
    tests.slice(0, 6000),
    '',
    `EXIT_CODE: ${execution.exitCode}`,
    'STDOUT:',
    execution.stdout.slice(-6000),
    'STDERR:',
    execution.stderr.slice(-6000),
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 700,
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const rawText = payload?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('\n').trim();
    if (!rawText) {
      return {
        explanation: 'AI explanation was empty. Review test output and fix the first failing assertion.',
        suggestions: ['Rerun after fixing the earliest visible error.'],
      };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      return {
        explanation: rawText,
        suggestions: [],
      };
    }

    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((entry) => String(entry)).filter(Boolean).slice(0, 6)
      : [];

    return {
      explanation: String(parsed.explanation || rawText),
      suggestions,
    };
  } finally {
    clearTimeout(timeout);
  }
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

async function ensureUserPvc(username, storageSize) {
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
          storage: storageSize || NOTEBOOK_PVC_SIZE,
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
  const quota = getEffectiveQuotaForUser(username);
  const baseName = sanitizeName(`nb-${username}-${sessionId.slice(0, 6)}`) || `nb-${sessionId.slice(0, 6)}`;
  const deploymentName = buildResourceName(baseName, 'dep');
  const serviceName = buildResourceName(baseName, 'svc');
  const pvcName = await ensureUserPvc(username, quota.storageSize);
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
                  memory: quota.memoryLimit,
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
  const quota = getEffectiveQuotaForUser(username);
  const containerName = buildResourceName(`nb-${username}-${sessionId.slice(0, 8)}`, 'ctr');
  const volumeName = buildResourceName(`nb-${username}`, 'vol');
  const notebookBaseUrl = buildNotebookBaseUrl(sessionId);
  const publicBaseUrl = buildPublicBaseUrl(sessionId);

  await ensureDockerVolume(volumeName);

  const containerConfig = {
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
      Memory: quota.memoryLimitBytes,
      MemoryReservation: Math.min(parseMemoryValueToBytes(NOTEBOOK_MEM_REQUEST), quota.memoryLimitBytes),
      StorageOpt: {
        size: `${quota.storageGi}G`,
      },
      RestartPolicy: {
        Name: 'unless-stopped',
      },
    },
    Labels: {
      app: 'colab-notebook',
      sessionId,
      username: sanitizeName(username),
    },
  };

  let container;
  try {
    container = await dockerApi.createContainer(containerConfig);
  } catch (err) {
    const errorMessage = err?.json?.message || err?.message || '';
    const storageOptUnsupported = /storage-?opt|size|quota/i.test(errorMessage);

    if (!storageOptUnsupported) {
      throw err;
    }

    // Retry without StorageOpt for Docker drivers that do not support writable-layer quotas.
    const fallbackConfig = {
      ...containerConfig,
      HostConfig: {
        ...containerConfig.HostConfig,
      },
    };
    delete fallbackConfig.HostConfig.StorageOpt;
    container = await dockerApi.createContainer(fallbackConfig);
  }

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

app.post('/auth/signup/request-otp', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ message: 'Missing username, email, or password' });
  }

  if (!email.toLowerCase().endsWith(`@${COLLEGE_DOMAIN}`)) {
    return res.status(400).json({ message: `Email must be from @${COLLEGE_DOMAIN} domain` });
  }

  if (users.has(username)) {
    return res.status(400).json({ message: 'Username already exists' });
  }

  // Check if email already used
  for (const [_, user] of users) {
    if (user.email === email.toLowerCase()) {
      return res.status(400).json({ message: 'Email already registered' });
    }
  }

  // Generate OTP
  const otp = generateOtp();
  const otpHash = hashOtp(otp);
  const hashedPassword = hashPassword(password);
  const expiresAt = Date.now() + OTP_EXPIRY_MS;

  // Store OTP verification data
  otpVerifications.set(email.toLowerCase(), {
    username,
    email: email.toLowerCase(),
    passwordHash: hashedPassword,
    otpHash,
    expiresAt,
    attempts: 0,
    lastSentAt: Date.now()
  });

  // Send OTP email
  const emailSent = await sendOtpEmail(email, otp);
  if (!emailSent) {
    otpVerifications.delete(email.toLowerCase());
    return res.status(500).json({ message: 'Failed to send OTP email' });
  }

  res.json({ message: 'OTP sent to email', email: email });
});

app.post('/auth/signup/verify-otp', (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ message: 'Missing email or OTP' });
  }

  const verificationData = otpVerifications.get(email.toLowerCase());
  if (!verificationData) {
    return res.status(400).json({ message: 'No pending verification for this email' });
  }

  if (Date.now() > verificationData.expiresAt) {
    otpVerifications.delete(email.toLowerCase());
    return res.status(400).json({ message: 'OTP expired' });
  }

  if (verificationData.attempts >= OTP_MAX_ATTEMPTS) {
    otpVerifications.delete(email.toLowerCase());
    return res.status(400).json({ message: 'Max attempts exceeded. Request OTP again.' });
  }

  const otpHash = hashOtp(otp);
  if (otpHash !== verificationData.otpHash) {
    verificationData.attempts++;
    return res.status(400).json({ message: `Invalid OTP. ${OTP_MAX_ATTEMPTS - verificationData.attempts} attempts remaining.` });
  }

  // OTP verified, create user
  const { username, passwordHash, email: userEmail } = verificationData;
  const userObject = normalizeUserRecord({
    password: passwordHash,
    role: 'user',
    email: userEmail,
    verified: true,
    verifiedAt: new Date().toISOString(),
  }, { isNewUser: true });

  users.set(username, userObject);
  saveUsers();

  // Create a directory for the user's notebooks
  const userNotebooksDir = path.join(notebooksDir, username);
  if (!fs.existsSync(userNotebooksDir)) {
    fs.mkdirSync(userNotebooksDir);
  }

  otpVerifications.delete(email.toLowerCase());

  const token = buildAuthToken(username, userObject);
  emitEvent('user_added', { username, role: userObject.role }, { toRole: 'admin' });
  res.json({ token, needsQuotaSetup: userObject.quotaSetupComplete === false });
});

app.post('/auth/signup', (req, res) => {
  const { username, password } = req.body;
  if (users.has(username)) {
    return res.status(400).json({ message: 'User already exists' });
  }
  const hashedPassword = hashPassword(password);
  const userObject = normalizeUserRecord({ password: hashedPassword, role: "user" }, { isNewUser: true }); // Default role
  if (username === "admin") { // Assign admin role for "admin" user
    userObject.role = "admin";
    userObject.quotaSetupComplete = true;
  }
  users.set(username, userObject);
  saveUsers(); // Save users after signup

  // Create a directory for the user's notebooks
  const userNotebooksDir = path.join(notebooksDir, username);
  if (!fs.existsSync(userNotebooksDir)) {
    fs.mkdirSync(userNotebooksDir);
  }

  const token = buildAuthToken(username, userObject);
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
  const token = buildAuthToken(username, user);
  res.json({ token });
});

app.post('/auth/quota', requiresAuth, (req, res) => {
  const username = req.user.username;
  const user = users.get(username);

  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }

  if (user.role === 'admin') {
    return res.status(400).json({ message: 'Quota setup is not required for admin accounts.' });
  }

  const { memoryMi, storageGi } = req.body || {};
  const validated = validateQuotaInput(memoryMi, storageGi);
  if (validated.error) {
    return res.status(400).json({ message: validated.error });
  }

  user.quota = {
    memoryMi: validated.memoryMi,
    storageGi: validated.storageGi,
    updatedAt: new Date().toISOString(),
  };
  user.quotaSetupComplete = true;
  users.set(username, user);
  saveUsers();

  const token = buildAuthToken(username, user);
  res.json({
    token,
    quotaSetupComplete: true,
    quota: user.quota,
  });
});

app.get('/auth/profile', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ message: 'Missing token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users.get(decoded.username);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      username: decoded.username,
      role: user.role,
      email: user.email || null,
      verified: user.verified || false,
      verifiedAt: user.verifiedAt || null,
      quotaSetupComplete: user.role === 'admin' ? true : user.quotaSetupComplete !== false,
      quota: normalizeUserQuota(user),
    });
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
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
  let requestedUser = null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = decoded.username; // Use username from decoded token
    requestedUser = user;
    const userRecord = users.get(user);

    if (!userRecord) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (userRecord.role !== 'admin' && userRecord.quotaSetupComplete === false) {
      return res.status(403).json({ message: 'Complete quota setup before launching your workspace.' });
    }

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

    emitEvent(
      'session_start_failed',
      {
        user: requestedUser,
        message: err?.message || 'Failed to create or restore notebook session',
      },
      {
        toRole: 'admin',
      }
    );

    if (requestedUser) {
      emitEvent(
        'session_start_failed',
        {
          user: requestedUser,
          message: err?.message || 'Failed to create or restore notebook session',
        },
        {
          toUsernames: [requestedUser],
        }
      );
    }

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

app.get('/admin/notebooks', requiresAdmin, async (req, res) => {
  try {
    const requestedUsername = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    const targetUsers = requestedUsername ? [requestedUsername] : Array.from(users.keys());

    if (requestedUsername && !users.has(requestedUsername)) {
      return res.status(404).json({ message: 'User not found' });
    }

    const items = [];
    for (const username of targetUsers) {
      let localItems = [];
      let liveItems = [];

      try {
        localItems = await listLocalNotebookFilesForUser(username);
      } catch (err) {
        localItems = [];
      }

      try {
        liveItems = await listLiveNotebookFilesForUser(username);
      } catch (err) {
        liveItems = [];
      }

      const dedup = new Map();
      [...localItems, ...liveItems].forEach((item) => {
        const key = `${item.username}:${item.notebookPath}`;
        if (!dedup.has(key) || dedup.get(key).source === 'local') {
          dedup.set(key, item);
        }
      });

      items.push(...dedup.values());
    }

    items.sort((left, right) => right.updatedAt - left.updatedAt);
    res.json({ generatedAt: Date.now(), items });
  } catch (err) {
    console.error('Failed to load admin notebook index:', err);
    res.status(500).json({ message: 'Failed to load notebooks' });
  }
});

app.get('/admin/notebook-content', requiresAdmin, async (req, res) => {
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  const notebookPath = typeof req.query.notebookPath === 'string' ? req.query.notebookPath.trim() : '';
  const source = req.query.source === 'live' ? 'live' : 'local';

  if (!username || !notebookPath) {
    return res.status(400).json({ message: 'username and notebookPath are required' });
  }

  if (!users.has(username)) {
    return res.status(404).json({ message: 'User not found' });
  }

  try {
    if (source === 'live') {
      const sessionEntry = findSessionEntryByUser(username);
      if (!sessionEntry?.session) {
        return res.status(404).json({ message: 'No live session found for this user' });
      }

      const encodedSegments = notebookPath
        .split('/')
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment));
      const routePath = encodedSegments.length > 0 ? `/${encodedSegments.join('/')}` : '';
      const url = `${sessionEntry.session.target}${sessionEntry.session.baseUrl}/api/contents${routePath}?content=1`;
      const response = await fetch(url, { method: 'GET' });

      if (!response.ok) {
        return res.status(response.status).json({ message: 'Failed to read notebook from live session' });
      }

      const payload = await response.json();
      const notebook = payload?.type === 'notebook' && payload?.content ? payload.content : payload;
      return res.json({ source: 'live', username, notebookPath, notebook });
    }

    const { targetPath } = resolveSafeNotebookPath(username, notebookPath);
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ message: 'Notebook not found' });
    }

    const raw = await fs.promises.readFile(targetPath, 'utf8');
    const notebook = JSON.parse(raw);
    res.json({ source: 'local', username, notebookPath, notebook });
  } catch (err) {
    console.error('Failed to load notebook content:', err);
    res.status(500).json({ message: 'Failed to load notebook content' });
  }
});

app.post('/code-analysis', requiresAuth, async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  const tests = typeof req.body?.tests === 'string' ? req.body.tests : '';
  const language = typeof req.body?.language === 'string' ? req.body.language.toLowerCase() : 'python';
  const coachingMode = normalizeCoachingMode(req.body?.coachingMode);

  if (!code.trim()) {
    return res.status(400).json({ message: 'Code is required for analysis.' });
  }

  if (language !== 'python') {
    return res.status(400).json({ message: 'Only python analysis is supported right now.' });
  }

  try {
    const execution = await runPythonSubmissionChecks(req.user.username, code, tests);
    const passed = execution.exitCode === 0;
    const hint = passed
      ? 'Great work. Tests passed for this submission.'
      : collectQuickHint(execution.stderr, execution.stdout);

    const ai = await callGeminiForFeedback({ code, tests, execution, coachingMode });

    return res.json({
      verdict: passed ? 'correct' : 'wrong',
      language,
      coachingMode,
      hint,
      explanation: ai.explanation,
      suggestions: ai.suggestions,
      testRun: {
        passed,
        exitCode: execution.exitCode,
        stdout: execution.stdout.slice(-4000),
        stderr: execution.stderr.slice(-4000),
      },
    });
  } catch (err) {
    console.error('Code analysis failed:', err);

    emitEvent(
      'code_analysis_failed',
      {
        user: req.user?.username || null,
        message: err?.message || 'Failed to analyse code.',
      },
      {
        toRole: 'admin',
      }
    );

    if (req.user?.username) {
      emitEvent(
        'code_analysis_failed',
        {
          user: req.user.username,
          message: err?.message || 'Failed to analyse code.',
        },
        {
          toUsernames: [req.user.username],
        }
      );
    }

    return res.status(500).json({
      verdict: 'error',
      message: err?.message || 'Failed to analyse code.',
      hint: 'Ensure your notebook session is running before triggering analysis.',
    });
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
