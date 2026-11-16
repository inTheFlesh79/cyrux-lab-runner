// Everything about the lab files on disk: the cache of lab zips and the extracted copy
// that each session runs from. Needs the `unzip` command (installed on the Linux host).
const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const execFileAsync = util.promisify(execFile);

// ---- Zip cache: one bundle.zip per lab, kept so the app does not have to resend it ----

function cachedZipPath(labid) {
    return path.join(config.cacheDir, String(labid), 'bundle.zip');
}

function hasCachedZip(labid) {
    return fs.existsSync(cachedZipPath(labid));
}

function saveZipToCache(labid, buffer) {
    const zipPath = cachedZipPath(labid);
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    fs.writeFileSync(zipPath, buffer);
}

// Forgets the cached zip of a lab, so the next start takes the new one from the app.
// Only safe when no session of that lab is open (the app makes sure of that before asking).
function deleteCachedZip(labid) {
    fs.rmSync(path.dirname(cachedZipPath(labid)), { recursive: true, force: true });
}

// ---- Session folders: the extracted lab of each session ----

function sessionDir(key) {
    return path.join(config.sessionsDir, key);
}

// Same as `find <root> -maxdepth 3 -name compose.yaml`, without a shell
function findComposeFile(root, maxDepth = 3) {
    const walk = (dir, depth) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return null;
        }

        for (const entry of entries) {
            if (entry.isFile() && entry.name === 'compose.yaml') return path.join(dir, entry.name);
        }

        if (depth >= maxDepth) return null;

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const found = walk(path.join(dir, entry.name), depth + 1);
                if (found) return found;
            }
        }
        return null;
    };

    return walk(root, 1);
}

// The lab's compose.yaml inside a session folder, or null if nothing was extracted
function findSessionCompose(key) {
    return findComposeFile(sessionDir(key));
}

// Starts the session from a clean folder: wipes any previous run, extracts the cached zip
// and returns the path of the lab's compose.yaml
async function extractLabToSession(key, labid) {
    const zipPath = cachedZipPath(labid);
    if (!fs.existsSync(zipPath)) {
        throw new Error('No cached zip found for this lab');
    }

    const dir = sessionDir(key);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await execFileAsync('unzip', ['-o', zipPath, '-d', dir], { maxBuffer: config.maxBuffer });

    const labCompose = findComposeFile(dir);
    if (!labCompose) {
        throw new Error('compose.yaml not found inside the extracted zip');
    }
    return labCompose;
}

module.exports = {
    hasCachedZip,
    saveZipToCache,
    deleteCachedZip,
    findComposeFile,
    findSessionCompose,
    extractLabToSession,
};
