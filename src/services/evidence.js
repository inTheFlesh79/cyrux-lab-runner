// Collects what a student did inside the lab's webtop container:
//  - bash history (the file is read when the lab stops)
//  - process history (sampled every few seconds while the lab runs)
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const SAMPLE_INTERVAL_MS = 10_000;
const MAX_EVIDENCE_CHARS = 200_000;
const MAX_DISTINCT_PROCESSES = 3000;
const MAX_PROCESS_LINE = 200;

// Appended to /etc/bash.bashrc inside the lab. Every prompt it saves new commands to the
// history file and resets the history settings, so they win over whatever ~/.bashrc sets.
// The marker makes it safe to run twice.
const HISTORY_SNIPPET = [
    '# cyrux-evidence: record every command as soon as it runs',
    'case "$PROMPT_COMMAND" in',
    '  *cyrux-history*) ;;',
    '  *) PROMPT_COMMAND="history -a; HISTCONTROL=; HISTSIZE=10000; HISTFILESIZE=10000; shopt -s histappend; : cyrux-history; ${PROMPT_COMMAND}" ;;',
    'esac',
].join('\n');

// sessionid -> { containerId, seen: Set of distinct command lines, busy, warned, timer }
const samplers = new Map();

// Postgres text columns reject NUL characters
function cleanText(text) {
    return String(text).replace(/\0/g, '');
}

function toKey(sessionid) {
    const key = String(sessionid);
    if (!/^\d+$/.test(key)) throw new Error('Invalid session id');
    return key;
}

// The container is found by the labels Docker Compose puts on it (project = the session id)
async function findWebtopContainer(sessionid) {
    const key = toKey(sessionid);
    const { stdout } = await execFileAsync('docker', [
        'ps', '-q',
        '--filter', `label=com.docker.compose.project=${key}`,
        '--filter', 'label=com.docker.compose.service=webtop',
    ], { timeout: 10_000 });

    return stdout.trim().split('\n')[0] || null;
}

async function injectHistoryConfig(containerId) {
    await execFileAsync('docker', [
        'exec', '-u', 'root',
        '-e', `CYRUX_SNIPPET=${HISTORY_SNIPPET}`,
        containerId,
        'sh', '-c',
        'grep -q cyrux-evidence /etc/bash.bashrc 2>/dev/null || printf "%s\\n" "$CYRUX_SNIPPET" >> /etc/bash.bashrc',
    ], { timeout: 10_000 });
}

// One snapshot of every command line running in the container (docker top runs on the host,
// so nothing has to be installed inside the container)
async function sampleProcesses(state) {
    // docker top needs the PID column in the output to pick the container's processes
    const { stdout } = await execFileAsync(
        'docker',
        ['top', state.containerId, '-eo', 'pid,args'],
        { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 }
    );

    // The first line is the header
    for (const raw of stdout.split('\n').slice(1)) {
        // Drop the PID column; what is left is the command line
        const line = raw.replace(/^\s*\d+\s+/, '').trim().slice(0, MAX_PROCESS_LINE);
        if (!line || state.seen.has(line)) continue;

        if (state.seen.size >= MAX_DISTINCT_PROCESSES) {
            // Drop the oldest line so the newest (what the student launched) always fits
            state.seen.delete(state.seen.values().next().value);
        }
        state.seen.add(line);
    }
}

function startSampler(sessionid, containerId) {
    const key = toKey(sessionid);
    stopSampler(key);

    const state = { containerId, seen: new Set(), busy: false, warned: false, timer: null };

    const tick = async () => {
        if (state.busy) return; // never pile up if docker is slow
        state.busy = true;
        try {
            await sampleProcesses(state);
        } catch (err) {
            if (!state.warned) {
                state.warned = true;
                console.error('Process sampling failed (further errors are hidden):', err.message);
            }
        } finally {
            state.busy = false;
        }
    };

    state.timer = setInterval(tick, SAMPLE_INTERVAL_MS);
    samplers.set(key, state);
    console.log(`[evidence] session ${key}: sampling started (container ${containerId.slice(0, 12)})`);
    tick();

    return state;
}

function stopSampler(sessionid) {
    const key = String(sessionid);
    const state = samplers.get(key);
    if (state) {
        clearInterval(state.timer);
        samplers.delete(key);
    }
    return state;
}

async function readBashHistory(containerId) {
    try {
        const { stdout } = await execFileAsync(
            'docker',
            ['exec', containerId, 'tail', '-c', String(MAX_EVIDENCE_CHARS), '/config/.bash_history'],
            { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }
        );
        return cleanText(stdout);
    } catch {
        return ''; // no history file (the student never ran a command) or the container is busy
    }
}

// Call right after the lab starts. Best effort: a failure here must never stop the lab.
async function prepareEvidence(sessionid) {
    try {
        const containerId = await findWebtopContainer(sessionid);
        if (!containerId) {
            console.log(`[evidence] session ${sessionid}: no webtop container found, nothing to record`);
            return;
        }

        await injectHistoryConfig(containerId);
        startSampler(sessionid, containerId);
    } catch (err) {
        console.error('Evidence setup error:', err.message);
    }
}

// A restart is a brand-new attempt: forget everything recorded so far, without keeping it
function discardEvidence(sessionid) {
    stopSampler(sessionid);
}

// Call BEFORE tearing the lab down on stop. It never throws.
// collected: false means there was nothing to collect (the lab was already down).
async function collectEvidence(sessionid) {
    const empty = { collected: false, bash: '', processes: '', connections: '' };

    try {
        const existing = samplers.get(String(sessionid));
        const containerId = existing?.containerId || await findWebtopContainer(sessionid);

        if (!containerId) {
            console.log(`[evidence] session ${sessionid}: no container found, nothing collected`);
            stopSampler(sessionid);
            return empty;
        }

        const bash = await readBashHistory(containerId);

        // One last snapshot so processes that are still running right now are included
        const state = existing || { containerId, seen: new Set() };
        try {
            await sampleProcesses(state);
        } catch (err) {
            console.error('Final process snapshot failed:', err.message);
        }
        stopSampler(sessionid);

        // The newest lines are the interesting ones, so when trimming keep the end
        const processes = cleanText([...state.seen].join('\n')).slice(-MAX_EVIDENCE_CHARS);

        console.log(`[evidence] session ${sessionid}: ${bash.length} chars of bash history, ${state.seen.size} distinct processes`);

        return { collected: true, bash, processes, connections: '' };
    } catch (err) {
        console.error('Evidence collection error:', err.message);
        stopSampler(sessionid);
        return empty;
    }
}

module.exports = { prepareEvidence, collectEvidence, discardEvidence };
