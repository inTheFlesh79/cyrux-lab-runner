// All settings of the runner, read once at startup from environment variables.
// Nothing else in the project reads process.env: ask this module instead.
//
// Every variable has a default, so the runner also starts without a .env file.
// See .env.example for the list.
const path = require('path');

// Root of the repository (this file is src/config/index.js)
const ROOT_DIR = path.resolve(__dirname, '..', '..');

function readPort(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`${name} must be a port number between 1 and 65535 (got "${raw}")`);
    }
    return value;
}

// Relative paths are relative to the repository root, absolute paths are used as they are
function readPath(name, fallback) {
    const raw = process.env[name];
    return path.resolve(ROOT_DIR, raw && raw.trim() ? raw.trim() : fallback);
}

const dataDir = readPath('DATA_DIR', path.join(ROOT_DIR, 'data'));

const config = {
    port: readPort('PORT', 4000),
    host: (process.env.HOST || '0.0.0.0').trim(),

    // The platform's base compose file (the reverse proxy every lab gets)
    baseCompose: readPath('BASE_COMPOSE', path.join(ROOT_DIR, 'base', 'base-proxy.yaml')),

    // Folder with the TLS certificate the labs' reverse proxy serves: labproxy.crt and labproxy.key.
    // Keep it outside the repository (it holds a private key).
    certsDir: readPath('CERTS_DIR', path.join(ROOT_DIR, 'certs')),

    // Runtime data. Not part of the repository (see .gitignore).
    dataDir,
    cacheDir: path.join(dataDir, 'labs-cache'),   // one bundle.zip per lab
    sessionsDir: path.join(dataDir, 'sessions'),  // the extracted lab of each session
    stateDir: path.join(dataDir, 'state'),        // one small JSON file per session

    // Fixed by base-proxy.yaml, so these are not settings: the service every lab is reached through
    proxyService: 'labaccessproxy',
    proxyPort: 443,

    // Big enough for the output of unzip and docker (a small buffer kills the command)
    maxBuffer: 50 * 1024 * 1024,
};

module.exports = Object.freeze(config);
