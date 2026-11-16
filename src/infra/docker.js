// Everything that runs the `docker` command lives here. The rest of the runner never calls
// docker directly, so this is the only file to replace if the labs ever run on something else.
//
// A session is one Compose project, named after the session id, made of the platform's
// base compose file plus the lab's own compose.yaml.
const { execFile, spawn } = require('child_process');
const util = require('util');
const path = require('path');
const config = require('../config');

const execFileAsync = util.promisify(execFile);

// base-proxy.yaml refers to two folders as ${CYRUX_BASE_DIR} and ${CYRUX_CERTS_DIR}.
// Compose fills them in from the environment of the docker command, so no path of this
// machine is written in the file. Every compose command must get this environment.
function composeEnv() {
    return {
        ...process.env,
        CYRUX_BASE_DIR: path.dirname(config.baseCompose),
        CYRUX_CERTS_DIR: config.certsDir,
    };
}

function composeArgs(key, labCompose, extra) {
    return [
        'compose', '-p', key,
        '--project-directory', path.dirname(labCompose),
        '-f', config.baseCompose,
        '-f', labCompose,
        ...extra,
    ];
}

// Runs `docker compose <args>` as a process that can be killed.
//   onStart(child)  gets the child process, so the caller can kill it (that is how a start is cancelled)
//   onOutput(text)  gets every piece of output docker prints
// Rejects with an Error whose `detail` is the last part of the output.
function runCompose(args, { onStart, onOutput } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], env: composeEnv() });
        if (onStart) onStart(child);
        let tail = '';

        const handleData = (chunk) => {
            const text = chunk.toString();
            tail = (tail + text).slice(-4000);
            if (onOutput) onOutput(text);
        };

        child.stdout.on('data', handleData);
        child.stderr.on('data', handleData);
        child.on('error', reject);
        child.on('close', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            const err = new Error(signal
                ? `docker compose was stopped (${signal})`
                : `docker compose exited with code ${code}`);
            err.detail = tail.trim();
            reject(err);
        });
    });
}

// The slow part of a start: pulls and builds images, then creates the containers
function composeUp(key, labCompose, hooks) {
    return runCompose(composeArgs(key, labCompose, ['up', '-d']), hooks);
}

async function composeDown(key, labCompose) {
    await execFileAsync('docker', composeArgs(key, labCompose, ['down']), {
        maxBuffer: config.maxBuffer,
        env: composeEnv(),
    });
}

// The host port a service of the session is published on
async function composePort(key, labCompose, service, containerPort) {
    const { stdout } = await execFileAsync(
        'docker',
        composeArgs(key, labCompose, ['port', service, String(containerPort)]),
        { maxBuffer: config.maxBuffer, env: composeEnv() }
    );

    const port = Number(stdout.trim().split(':').pop());
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error('Could not read the lab port');
    }
    return port;
}

// Is that service of the session up? (found by the labels Compose puts on its containers)
async function isServiceRunning(key, service) {
    try {
        const { stdout } = await execFileAsync('docker', [
            'ps', '-q',
            '--filter', `label=com.docker.compose.project=${key}`,
            '--filter', `label=com.docker.compose.service=${service}`,
        ], { timeout: 10_000 });
        return stdout.trim().length > 0;
    } catch {
        return false;
    }
}

module.exports = { composeUp, composeDown, composePort, isServiceRunning };
