FROM node:18-alpine
WORKDIR /app

# Copy package files first for better caching
COPY server/package.json server/package-lock.json ./
RUN npm install --production

# Copy ALL server files from server/ directory
COPY server/ ./

# Create directories for persistent data
RUN mkdir -p /app/data /app/notebooks
# Declare volumes for Docker Compose
VOLUME ["/app/data", "/app/notebooks"]

EXPOSE 5000
CMD ["node", "index.js"]
