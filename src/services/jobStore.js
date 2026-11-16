// Keeps track of every session the runner knows about: its phase, its port and any error.
//
// A start goes through these phases, in this order:
//   preparing -> building -> starting -> finalizing -> ready
// and a job can also end as:
//   failed     the start did not work
//   cancelled  the student cancelled it while it was still starting
//   stopped    the lab was closed after being ready
//
// Records live in memory while the runner is up. Every phase change is also written to a
// small JSON file, so after a runner restart it still knows what happened to a session.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const IN_PROGRESS = new Set(['preparing', 'building', 'starting', 'finalizing']);

// sessionid -> { key, labid, phase, port, protocol, error, detail, child, cancelled, startedAt, done }
const jobs = new Map();

// Call once at startup
function init() {
    fs.mkdirSync(config.stateDir, { recursive: true });
}

function createJob(key, labid) {
    const job = {
        key,
        labid,
        phase: 'preparing',
        port: null,
        protocol: null,
        error: null,   // short message the app can show to the student
        detail: null,  // technical tail of the docker output, only for the logs
        child: null,   // the running `docker compose up` process, so it can be killed
        cancelled: false,
        startedAt: Date.now(),
        done: Promise.resolve(),
    };
    jobs.set(key, job);
    return job;
}

function getJob(key) {
    return jobs.get(key);
}

function isInProgressPhase(phase) {
    return IN_PROGRESS.has(phase);
}

function isInProgress(job) {
    return !!job && IN_PROGRESS.has(job.phase);
}

// What the app is allowed to see of a job
function publicState(job) {
    return {
        phase: job.phase,
        port: job.port,
        protocol: job.protocol,
        error: job.error,
        detail: job.detail,
    };
}

function statePath(key) {
    return path.join(config.stateDir, `${key}.json`);
}

function setPhase(job, phase) {
    job.phase = phase;
    try {
        fs.writeFileSync(
            statePath(job.key),
            JSON.stringify({ ...publicState(job), labid: job.labid, updatedAt: new Date().toISOString() })
        );
    } catch (err) {
        console.error('State write failed:', err.message);
    }
    console.log(`[start] session ${job.key}: ${phase}`);
}

// The state a previous run of the runner left on disk, or null
function readStateFile(key) {
    try {
        return JSON.parse(fs.readFileSync(statePath(key), 'utf8'));
    } catch {
        return null;
    }
}

module.exports = {
    init,
    createJob,
    getJob,
    isInProgress,
    isInProgressPhase,
    publicState,
    setPhase,
    readStateFile,
};
