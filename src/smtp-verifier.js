/**
 * Real-time SMTP verification to reduce bounces (not to "prove" validity).
 * Catches: domains with no MX, dead mailboxes, clear 5xx "user unknown".
 * MX lookup + connect + RCPT TO check; no email is sent.
 * Pipeline-style steps (adopted from promise-based SMTP ping pattern).
 * Tries ports in order: 25 (often blocked) → 587 (STARTTLS) → 465 (implicit TLS).
 * Status: verified | invalid | catch_all | unknown | error
 */

const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const DEFAULT_TIMEOUT_MS = 12000;
const CONNECT_TIMEOUT_MS = 8000;
const PORTS_TO_TRY = [25, 587, 465];

const SmtpStatus = { OK: 'verified', INVALID: 'invalid', UNKNOWN: 'unknown', ERROR: 'error' };
const SmtpCode = { READY: 220, OK: 250, MAILBOX_UNAVAILABLE: 550 };

/**
 * Many servers return 550 for "we don't do verification" (anti-abuse), not "user unknown".
 * If the response text suggests policy/block, treat as UNKNOWN (inconclusive) not INVALID (would bounce).
 */
function isLikelyPolicyReject(response) {
  if (!response || !response.response) return false;
  const text = response.response.toLowerCase();
  const policyPatterns = ['reject', 'policy', 'not accept', 'block', 'denied', 'refuse', 'spam', 'abuse', 'try again later', 'temporarily'];
  return policyPatterns.some((p) => text.includes(p));
}

// -- utils --
const strip = (str) => (str || '').replace(/\n|\r/g, '').trim();
const after = (str, char) => str.substring(str.lastIndexOf(char) + 1);

const buildSmtpResponse = (command, response) => ({
  command: command ? strip(command) : command,
  response: response ? strip(response) : response,
  code: response ? parseInt(response.substring(0, 3), 10) : null
});

/**
 * Create a promise-based read helper for an SMTP socket.
 * Resolves with the next complete SMTP response (handles 250-continuation lines).
 */
function createSmtpReader(socket) {
  let buffer = '';
  const readResponse = () =>
    new Promise((resolve, reject) => {
      const onData = (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const code = parseInt(line.slice(0, 3), 10);
          const isContinuation = line.length > 3 && line[3] === '-';
          if (!isContinuation) {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            resolve(buildSmtpResponse(null, line));
            return;
          }
        }
      };
      const onError = (err) => {
        socket.removeListener('data', onData);
        reject(err);
      };
      socket.on('data', onData);
      socket.on('error', onError);
    });
  return readResponse;
}

/**
 * Execute pipeline of SMTP steps. Each step receives { socket, readResponse, email, mx, commandHistory, next }.
 * Step returns { complete, status } or calls next() to continue.
 */
async function executePipeline(pipeline, ctx) {
  if (pipeline.length === 0) return { complete: true, status: SmtpStatus.UNKNOWN };
  const step = pipeline[0];
  const next = async () => executePipeline(pipeline.slice(1), ctx);
  return await step({ ...ctx, next });
}

// -- SMTP pipeline (plain or after TLS) --
const smtpPipeline = [
  async ({ readResponse, commandHistory, next }) => {
    const response = await readResponse();
    commandHistory.push(response);
    if (response.code === SmtpCode.READY) return await next();
    return { complete: false, status: SmtpStatus.UNKNOWN };
  },
  async ({ socket, readResponse, commandHistory, next }) => {
    const command = 'EHLO localhost\r\n';
    socket.write(command);
    const response = await readResponse();
    commandHistory.push(response);
    if (response.code === SmtpCode.OK) return await next();
    return { complete: false, status: SmtpStatus.UNKNOWN };
  },
  async ({ socket, readResponse, commandHistory, next }) => {
    const command = 'MAIL FROM:<>\r\n';
    socket.write(command);
    const response = await readResponse();
    commandHistory.push(response);
    if (response.code === SmtpCode.OK) return await next();
    return { complete: false, status: SmtpStatus.UNKNOWN };
  },
  async ({ socket, readResponse, commandHistory, email }) => {
    const command = `RCPT TO:<${email}>\r\n`;
    socket.write(command);
    const response = await readResponse();
    commandHistory.push(response);
    if (response.code >= 250 && response.code <= 259) {
      return { complete: true, status: SmtpStatus.OK };
    }
    if (response.code >= 450 && response.code <= 452) {
      return { complete: true, status: SmtpStatus.UNKNOWN };
    }
    if (response.code >= 550 && response.code <= 554) {
      return { complete: true, status: isLikelyPolicyReject(response) ? SmtpStatus.UNKNOWN : SmtpStatus.INVALID };
    }
    return { complete: true, status: SmtpStatus.UNKNOWN };
  }
];

/**
 * Run plain SMTP pipeline on an already-connected socket (port 25).
 */
async function runPlainPipeline(socket, email, mx, commandHistory) {
  const readResponse = createSmtpReader(socket);
  const result = await executePipeline(smtpPipeline, {
    socket,
    readResponse,
    email,
    mx,
    commandHistory
  });
  return { ...result, commandHistory };
}

/**
 * Run pipeline after TLS is up (465 or after STARTTLS on 587).
 */
async function runAfterTls(socket, email, mx, commandHistory) {
  const readResponse = createSmtpReader(socket);
  // After TLS we need EHLO again; skip the 220 greeting step
  const pipelineAfterTls = [
    async ({ socket: s, readResponse: r, commandHistory: h, next }) => {
      s.write('EHLO localhost\r\n');
      const response = await r();
      h.push(response);
      if (response.code === SmtpCode.OK) return await next();
      return { complete: false, status: SmtpStatus.UNKNOWN };
    },
    async ({ socket: s, readResponse: r, commandHistory: h, next }) => {
      s.write('MAIL FROM:<>\r\n');
      const response = await r();
      h.push(response);
      if (response.code === SmtpCode.OK) return await next();
      return { complete: false, status: SmtpStatus.UNKNOWN };
    },
    async ({ socket: s, readResponse: r, commandHistory: h }) => {
      s.write(`RCPT TO:<${email}>\r\n`);
      const response = await r();
      h.push(response);
      if (response.code >= 250 && response.code <= 259) return { complete: true, status: SmtpStatus.OK };
      if (response.code >= 450 && response.code <= 452) return { complete: true, status: SmtpStatus.UNKNOWN };
      if (response.code >= 550 && response.code <= 554) return { complete: true, status: isLikelyPolicyReject(response) ? SmtpStatus.UNKNOWN : SmtpStatus.INVALID };
      return { complete: true, status: SmtpStatus.UNKNOWN };
    }
  ];
  const result = await executePipeline(pipelineAfterTls, {
    socket,
    readResponse,
    email,
    mx,
    commandHistory
  });
  return { ...result, commandHistory };
}

/**
 * Connect on port 25, run plain pipeline.
 */
function tryPort25(mx, email, timeoutMs, connectTimeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const commandHistory = [];
    socket.setEncoding('utf8');
    socket.setTimeout(connectTimeoutMs);
    const onErr = (err) => {
      try { socket.destroy(); } catch (_) {}
      reject(err);
    };
    socket.on('error', onErr);
    socket.on('timeout', () => onErr(new Error('Connection timeout')));
    socket.connect(25, mx, async () => {
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => onErr(new Error('Timeout')));
      socket.on('error', onErr);
      try {
        const result = await runPlainPipeline(socket, email, mx, commandHistory);
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        try { socket.destroy(); } catch (_) {}
      }
    });
  });
}

/**
 * Connect on port 587, STARTTLS, then run pipeline.
 */
function tryPort587(mx, email, timeoutMs, connectTimeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const commandHistory = [];
    socket.setEncoding('utf8');
    socket.setTimeout(connectTimeoutMs);
    const onErr = (err) => {
      try { socket.destroy(); } catch (_) {}
      reject(err);
    };
    socket.on('error', onErr);
    socket.on('timeout', () => onErr(new Error('Connection timeout')));
    socket.connect(587, mx, async () => {
      socket.removeAllListeners('timeout');
      socket.removeAllListeners('error');
      socket.setTimeout(timeoutMs);
      const readResponse = createSmtpReader(socket);
      try {
        const r1 = await readResponse();
        commandHistory.push(r1);
        if (r1.code !== SmtpCode.READY) {
          return reject(new Error('Unexpected greeting: ' + (r1.response || '')));
        }
        socket.write('EHLO localhost\r\n');
        const r2 = await readResponse();
        commandHistory.push(r2);
        if (r2.code !== SmtpCode.OK) {
          return reject(new Error('EHLO failed: ' + (r2.response || '')));
        }
        if (!(r2.response || '').includes('STARTTLS')) {
          return reject(new Error('STARTTLS not advertised'));
        }
        socket.write('STARTTLS\r\n');
        const r3 = await readResponse();
        commandHistory.push(r3);
        if (r3.code !== SmtpCode.READY) {
          return reject(new Error('STARTTLS failed: ' + (r3.response || '')));
        }
        const tlsSocket = tls.connect({
          socket,
          servername: mx,
          rejectUnauthorized: false
        }, async () => {
          tlsSocket.removeAllListeners('error');
          tlsSocket.setTimeout(0);
          try {
            const result = await runAfterTls(tlsSocket, email, mx, commandHistory);
            resolve(result);
          } catch (e) {
            reject(e);
          } finally {
            try { tlsSocket.destroy(); } catch (_) {}
          }
        });
        tlsSocket.on('error', (err) => reject(err));
      } catch (e) {
        reject(e);
      } finally {
        try { socket.destroy(); } catch (_) {}
      }
    });
  });
}

/**
 * Connect on port 465 (implicit TLS), then run pipeline.
 */
function tryPort465(mx, email, timeoutMs, connectTimeoutMs) {
  return new Promise((resolve, reject) => {
    const commandHistory = [];
    const socket = tls.connect(465, mx, {
      servername: mx,
      rejectUnauthorized: false
    }, async () => {
      socket.removeAllListeners('error');
      socket.setTimeout(timeoutMs);
      socket.setEncoding('utf8');
      try {
        const result = await runAfterTls(socket, email, mx, commandHistory);
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        try { socket.destroy(); } catch (_) {}
      }
    });
    socket.setTimeout(connectTimeoutMs);
    socket.on('error', (err) => reject(err));
    socket.on('timeout', () => reject(new Error('Connection timeout')));
  });
}

async function resolveMx(domain) {
  const records = await dns.resolveMx(domain);
  if (!records || records.length === 0) return [];
  return records.sort((a, b) => (a.priority || 0) - (b.priority || 0));
}

/**
 * Verify one email via SMTP RCPT TO. Tries ports 25 → 587 → 465 per MX.
 * @param {string} email
 * @param {{ timeout?: number }} options
 * @returns {Promise<{ isValid: boolean, status: string, details?: object }>}
 */
function verifyEmailSmtp(email, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      resolve({ isValid: false, status: 'invalid', details: { error: 'Invalid email format' } });
      return;
    }
    const domain = after(email, '@');
    if (!domain) {
      resolve({ isValid: false, status: 'invalid', details: { error: 'Missing domain' } });
      return;
    }

    const timer = setTimeout(() => {
      resolve({
        isValid: false,
        status: 'error',
        details: { error: 'Timeout connecting or during SMTP handshake' }
      });
    }, timeout);

    resolveMx(domain)
      .then(async (mxRecords) => {
        if (mxRecords.length === 0) {
          clearTimeout(timer);
          resolve({ isValid: false, status: 'invalid', details: { error: 'No MX records for domain' } });
          return;
        }

        const tryPorts = [
          { port: 25, try: (mx) => tryPort25(mx, email, timeout, CONNECT_TIMEOUT_MS) },
          { port: 587, try: (mx) => tryPort587(mx, email, timeout, CONNECT_TIMEOUT_MS) },
          { port: 465, try: (mx) => tryPort465(mx, email, timeout, CONNECT_TIMEOUT_MS) }
        ];

        let lastError = null;
        for (const mxRec of mxRecords) {
          const mx = mxRec.exchange;
          for (const { port, try: tryFn } of tryPorts) {
            try {
              const result = await tryFn(mx);
              clearTimeout(timer);
              const status = result.status === SmtpStatus.OK ? 'verified' : result.status === SmtpStatus.INVALID ? 'invalid' : 'unknown';
              resolve({
                isValid: result.status === SmtpStatus.OK,
                status,
                details: {
                  mx,
                  port,
                  smtp_response: result.commandHistory && result.commandHistory.length ? result.commandHistory[result.commandHistory.length - 1].response : undefined,
                  commandHistory: result.commandHistory
                }
              });
              return;
            } catch (err) {
              lastError = err;
            }
          }
        }

        clearTimeout(timer);
        resolve({
          isValid: false,
          status: 'error',
          details: { error: lastError ? lastError.message : 'All MX servers and ports failed' }
        });
      })
      .catch((err) => {
        clearTimeout(timer);
        resolve({
          isValid: false,
          status: 'error',
          details: { error: err.message || 'MX lookup failed' }
        });
      });
  });
}

/**
 * Verify email using syntax + MX only (no SMTP connection, no RCPT TO).
 * Not blocked by anti-verification; only confirms format and domain accepts mail.
 * @param {string} email
 * @returns {Promise<{ isValid: boolean, status: string, details?: object }>}
 */
function verifyEmailMxSyntax(email) {
  if (!email || typeof email !== 'string') {
    return Promise.resolve({ isValid: false, status: 'invalid', details: { error: 'Invalid email format' } });
  }
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) {
    return Promise.resolve({ isValid: false, status: 'invalid', details: { error: 'Invalid email format' } });
  }
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain || !domain.includes('.')) {
    return Promise.resolve({ isValid: false, status: 'invalid', details: { error: 'Invalid email format' } });
  }
  if (/[^\w.+-]/.test(local) || /[^\w.-]/.test(domain)) {
    return Promise.resolve({ isValid: false, status: 'invalid', details: { error: 'Invalid email format' } });
  }
  return resolveMx(domain)
    .then((mxRecords) => {
      if (!mxRecords || mxRecords.length === 0) {
        return { isValid: false, status: 'invalid', details: { error: 'No MX records for domain' } };
      }
      return {
        isValid: true,
        status: 'verified',
        details: { method: 'mx_syntax', mx: mxRecords[0].exchange }
      };
    })
    .catch((err) => ({
      isValid: false,
      status: 'error',
      details: { error: err.message || 'MX lookup failed' }
    }));
}

module.exports = {
  resolveMx,
  verifyEmailSmtp,
  verifyEmailMxSyntax
};
