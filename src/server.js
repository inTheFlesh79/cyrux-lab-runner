// CyruxLabs lab runner.
//
// Starting a lab is a background job: POST /start answers right away (202) and the app
// asks GET /status/:sessionid how it is going. POST /stop also cancels a start that is
// still running (it kills the docker compose process, then tears everything down).
//
// This file is being split into layers (routes, controllers, services, infra).
// Config, the job store, and the docker and file helpers already live in their own modules.
// The launcher and the endpoints stay here until the next steps.
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const config = require('./config');
const { parseId } = require('./utils/ids');
const jobStore = require('./services/jobStore');
const docker = require('./infra/docker');
const labFiles = require('./infra/labFiles');
const { prepareEvidence, collectEvidence, discardEvidence } = require('./services/evidence');

const app = express();

const EMPTY_EVIDENCE = { collected: false, bash: '', processes: '', connections: '' };

// Compose prints lines like "Container 12-webtop-1  Created" once the images are ready
const CONTAINER_PROGRESS = /Container\s+\S+\s+(Creating|Created|Starting|Started)/i;

// Fail fast: a wrong path would otherwise only show up when the first lab is started
if (!fs.existsSync(config.baseCompose)) {
    console.error(`Base compose file not found: ${config.baseCompose} (set BASE_COMPOSE in .env)`);
    process.exit(1);
}

// Same for the certificate the labs' proxy serves (see base/default.conf)
for (const file of ['labproxy.crt', 'labproxy.key']) {
    const certPath = path.join(config.certsDir, file);
    if (!fs.existsSync(certPath)) {
        console.error(`Certificate file not found: ${certPath} (set CERTS_DIR in .env)`);
        process.exit(1);
    }
}

jobStore.init();

const upload = multer({ storage: multer.memoryStorage() });

// KNOWN LIMITATION (future work): CORS is open to every origin and the API has no
// authentication. Only the app's backend calls this API, so it could be restricted.
app.use(cors());
app.use(express.json());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `docker compose down` for a session. Nothing extracted means nothing to tear down.
async function tearDown(key) {
    const labCompose = labFiles.findSessionCompose(key);
    if (!labCompose) return;

    await docker.composeDown(key, labCompose);
}

// ---------------------------------------------------------------------------
// The start job
// ---------------------------------------------------------------------------

async function runStartJob(job) {
    const { key, labid } = job;

    try {
        jobStore.setPhase(job, 'preparing');

        const labCompose = await labFiles.extractLabToSession(key, labid);

        if (job.cancelled) throw new Error('cancelled');

        // The slow part: pulling and building images, then creating the containers
        jobStore.setPhase(job, 'building');
        const composeStart = Date.now();

        try {
            await docker.composeUp(key, labCompose, {
                onStart: (child) => { job.child = child; },
                onOutput: (text) => {
                    // Best effort: once Compose reports containers being created, the images are done
                    if (job.phase === 'building' && CONTAINER_PROGRESS.test(text)) {
                        jobStore.setPhase(job, 'starting');
                    }
                },
            });
        } finally {
            job.child = null;
        }

        console.log(`[start] session ${key}: compose up took ${Math.round((Date.now() - composeStart) / 1000)} s`);

        if (job.cancelled) throw new Error('cancelled');

        jobStore.setPhase(job, 'finalizing');

        const port = await docker.composePort(key, labCompose, config.proxyService, config.proxyPort);

        // Start recording what the student does (history settings + process sampling)
        await prepareEvidence(key);

        job.port = port;
        job.protocol = 'https';
        jobStore.setPhase(job, 'ready');
        console.log(`[start] session ${key}: ready in ${Math.round((Date.now() - job.startedAt) / 1000)} s`);
    } catch (err) {
        if (job.cancelled) {
            jobStore.setPhase(job, 'cancelled');
            return;
        }

        console.error(`[start] session ${key} failed:`, err.message);
        job.error = 'No se pudo construir o arrancar el laboratorio.';
        job.detail = String(err.detail || err.message).slice(-1000);

        // Remove whatever got half created
        try {
            await tearDown(key);
        } catch (downErr) {
            console.error(`[start] session ${key}: teardown after failure failed:`, downErr.message);
        }
        jobStore.setPhase(job, 'failed');
    }
}

// Stops a start that is still running: kills docker compose and waits for the job to notice
async function cancelJob(job) {
    job.cancelled = true;
    if (job.child) job.child.kill('SIGTERM');
    // Never wait forever for it
    await Promise.race([job.done, sleep(60_000)]);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

// Accepts the start and answers immediately; the app follows progress with /status
app.post('/start', upload.single('zipfile'), async (req, res) => {
    let key;
    let labKey;
    try {
        key = parseId(req.body.sessionid);
        labKey = parseId(req.body.labid);
    } catch {
        return res.status(400).json({ message: 'Invalid labid or sessionid' });
    }

    try {
        // Asking twice for the same session must not start it twice
        const existing = jobStore.getJob(key);
        if (existing && (
            jobStore.isInProgress(existing)
            || (existing.phase === 'ready' && await docker.isServiceRunning(key, config.proxyService))
        )) {
            return res.status(202).json({ message: 'Start already in progress', ...jobStore.publicState(existing) });
        }

        if (!labFiles.hasCachedZip(labKey)) {
            if (!req.file) {
                return res.status(400).json({ message: 'Missing zipfile' });
            }
            labFiles.saveZipToCache(labKey, req.file.buffer);
        }

        const job = jobStore.createJob(key, labKey);
        job.done = runStartJob(job); // runs in the background; it never rejects
        res.status(202).json({ message: 'Start accepted', ...jobStore.publicState(job) });
    } catch (err) {
        console.error('Start error:', err);
        res.status(500).json({ message: 'Failed to start lab', error: err.message });
    }
});

// How is the start going? Also tells the app whether a "ready" lab is still alive.
app.get('/status/:sessionid', async (req, res) => {
    let key;
    try {
        key = parseId(req.params.sessionid);
    } catch {
        return res.status(400).json({ message: 'Invalid sessionid' });
    }

    try {
        const job = jobStore.getJob(key);
        const state = job ? jobStore.publicState(job) : jobStore.readStateFile(key);

        if (!state) return res.json({ phase: 'unknown' });

        // Written to disk by a previous run of the runner, so that start can never finish
        if (!job && jobStore.isInProgressPhase(state.phase)) {
            return res.json({
                phase: 'failed',
                port: null,
                protocol: null,
                error: 'El runner se reinició mientras se iniciaba el laboratorio.',
                detail: 'runner restarted during the start',
            });
        }

        if (state.phase === 'ready' && !(await docker.isServiceRunning(key, config.proxyService))) {
            return res.json({ ...state, phase: 'gone' });
        }

        res.json(state);
    } catch (err) {
        console.error('Status error:', err);
        res.status(500).json({ message: 'Failed to read status', error: err.message });
    }
});

// The app replaced a lab's zip (new zip + new flag): forget the cached copy so the next start
// uses the new one. The app only asks when no session of that lab is open.
app.delete('/cache/:labid', (req, res) => {
    let labKey;
    try {
        labKey = parseId(req.params.labid);
    } catch {
        return res.status(400).json({ message: 'Invalid labid' });
    }

    try {
        labFiles.deleteCachedZip(labKey);
        console.log(`[cache] lab ${labKey}: cached zip removed`);
        res.json({ message: 'Cache cleared' });
    } catch (err) {
        console.error('Cache clear error:', err);
        res.status(500).json({ message: 'Failed to clear the cache', error: err.message });
    }
});

// A restart is a brand-new attempt: nothing from the old one is kept.
// Still synchronous (the app waits for the new lab to be ready).
app.post('/restart', async (req, res) => {
    let key;
    let labKey;
    try {
        key = parseId(req.body.sessionid);
        labKey = parseId(req.body.labid);
    } catch {
        return res.status(400).json({ message: 'Invalid labid or sessionid' });
    }

    try {
        discardEvidence(key);

        const old = jobStore.getJob(key);
        if (jobStore.isInProgress(old)) {
            await cancelJob(old);
        }

        await tearDown(key).catch(() => {}); // fine if there was nothing running to tear down

        const job = jobStore.createJob(key, labKey);
        job.done = runStartJob(job);
        await job.done;

        if (job.phase !== 'ready') {
            return res.status(500).json({
                message: 'Failed to restart lab',
                error: job.detail || job.error || 'Unknown error',
            });
        }

        res.json({ message: 'Lab restarted', port: job.port, protocol: job.protocol });
    } catch (err) {
        console.error('Restart error:', err);
        res.status(500).json({ message: 'Failed to restart lab', error: err.message });
    }
});

// Ends a session. If its start is still running this is a cancel: the build is killed
// and nothing is collected. Otherwise the student's evidence is collected first.
app.post('/stop', async (req, res) => {
    let key;
    try {
        key = parseId(req.body.sessionid);
    } catch {
        return res.status(400).json({ message: 'Invalid sessionid' });
    }

    try {
        const job = jobStore.getJob(key);
        let evidence = EMPTY_EVIDENCE;

        if (jobStore.isInProgress(job)) {
            await cancelJob(job);
            discardEvidence(key);
        } else {
            // Collect what the student did BEFORE the containers disappear
            evidence = await collectEvidence(key);
        }

        await tearDown(key);

        if (job && job.phase !== 'cancelled' && job.phase !== 'failed') {
            jobStore.setPhase(job, 'stopped');
        }

        res.json({ message: 'Lab stopped', evidence });
    } catch (err) {
        console.error('Stop error:', err);
        res.status(500).json({ message: 'Failed to stop lab', error: err.message });
    }
});

app.listen(config.port, config.host, () => {
    console.log(`Runner listening on http://${config.host}:${config.port}`);
    console.log(`[config] data dir: ${config.dataDir}`);
});
