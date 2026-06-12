/* ============================================================
   iLabels API Worker
   ilabels-api.iosflowzy.workers.dev

   Minimal licensing system:
   - Plisio creates one license after paid webhook
   - Cloudflare KV stores licenses
   - One license allows max 2 devices
   - No email, accounts, subscriptions, dashboard, or database
   ============================================================ */

const CORS = {
  'Access-Control-Allow-Origin': 'https://ilabels.iosflowzy.workers.dev',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
};

const LICENSE_KEY_PATTERN = /^ILBL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MAX_DEVICES = 2;
const DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;
const ORDER_TTL_SECONDS = 7 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    let response;
    const path = normalizePath(url.pathname);

    try {
      if (path === '/api/create-order' && request.method === 'POST') {
        response = await createOrder(env);
      } else if (path === '/api/status' && request.method === 'GET') {
        response = await getStatus(url, env);
      } else if (path === '/api/download' && request.method === 'GET') {
        response = await download(url, env);
      } else if (path === '/api/plisio/webhook' && request.method === 'POST') {
        response = await plisioWebhook(request, env);
      } else if ((path === '/api/activate' || path === '/activate') && request.method === 'POST') {
        response = await activate(request, env);
      } else if ((path === '/api/validate' || path === '/validate') && request.method === 'POST') {
        response = await validate(request, env);
      } else if ((path === '/api/admin/reset' || path === '/admin/reset') && request.method === 'POST') {
        response = await adminReset(request, env);
      } else if (path === '/api/test' && request.method === 'GET') {
        response = await createTestOrder(env);
      } else {
        response = json({ success: false, error: 'not found' }, 404);
      }
    } catch (error) {
      response = json({ success: false, error: 'internal error' }, 500);
    }

    return withCors(response);
  },
};

/* ============================================================
   POST /api/create-order
   Site calls this when the user clicks Buy.
   Creates a pending order in KV, creates Plisio invoice, returns invoiceUrl.
   ============================================================ */
async function createOrder(env) {
  const orderNumber = generateOrderId();
  const siteDomain = env.SITE_DOMAIN;
  const apiDomain = env.API_DOMAIN;

  const params = new URLSearchParams({
    source_currency: 'USD',
    source_amount: '10',
    order_number: orderNumber,
    order_name: 'iLabels Plugin',
    description: 'iLabels — After Effects label script',
    callback_url: `https://${apiDomain}/api/plisio/webhook?json=true`,
    success_invoice_url: `https://${siteDomain}/success.html?order=${orderNumber}`,
    fail_invoice_url: `https://${siteDomain}/?payment=failed`,
    api_key: env.PLISIO_API_KEY,
    expire_min: '60',
  });

  const plisioResponse = await fetch(`https://api.plisio.net/api/v1/invoices/new?${params}`);
  const plisioJson = await plisioResponse.json().catch(() => ({}));

  if (!plisioJson.data?.invoice_url) {
    return json({ success: false, error: 'Plisio error', details: plisioJson }, 502);
  }

  await env.KV.put(
    `order:${orderNumber}`,
    JSON.stringify({
      status: 'pending',
      createdAt: Date.now(),
    }),
    { expirationTtl: DOWNLOAD_TTL_SECONDS },
  );

  return json({ invoiceUrl: plisioJson.data.invoice_url, orderNumber });
}

/* ============================================================
   GET /api/status?order=ORDER_NUMBER
   success.html polls this endpoint. Once paid, it receives licenseKey
   and one-time downloadToken.
   ============================================================ */
async function getStatus(url, env) {
  const orderNumber = url.searchParams.get('order');

  if (!orderNumber) {
    return json({ success: false, error: 'missing order' }, 400);
  }

  const order = await getJson(env.KV, `order:${orderNumber}`);

  if (!order) {
    return json({ status: 'not_found' });
  }

  if (order.status !== 'paid') {
    return json({ status: order.status || 'pending' });
  }

  return json({
    status: 'paid',
    licenseKey: order.licenseKey,
    downloadToken: order.downloadToken,
  });
}

/* ============================================================
   GET /api/download?token=TOKEN
   One-time download redirect.
   ============================================================ */
async function download(url, env) {
  const token = url.searchParams.get('token');

  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  const key = `dl:${token}`;
  const record = await getJson(env.KV, key);

  if (!record) {
    return new Response('Link expired or invalid', { status: 410 });
  }

  if (record.used) {
    return new Response('Link already used', { status: 410 });
  }

  if (Date.now() > Number(record.expires || 0)) {
    await env.KV.delete(key);
    return new Response('Link expired', { status: 410 });
  }

  record.used = true;
  await env.KV.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 });

  return Response.redirect(env.GOOGLE_DRIVE_URL, 302);
}

/* ============================================================
   POST /api/plisio/webhook
   Plisio calls this after payment status changes.
   On paid status, creates exactly one license for the order.
   ============================================================ */
async function plisioWebhook(request, env) {
  const body = await readBody(request);

  if (!body || typeof body !== 'object') {
    return json({ success: false, error: 'invalid body' }, 400);
  }

  if (env.PLISIO_SECRET_KEY || env.PLISIO_SECRET) {
    const secret = env.PLISIO_SECRET_KEY || env.PLISIO_SECRET;
    const valid = await verifyPlisio(body, secret);

    if (!valid) {
      return json({ success: false, error: 'invalid plisio webhook' }, 401);
    }
  }

  if (mapStatus(body.status || body.order_status || body.txn_status) !== 'paid') {
    return json({ success: true, skipped: true });
  }

  const orderNumber = String(body.order_number || '').trim();

  if (!orderNumber) {
    return json({ success: false, error: 'missing order_number' }, 400);
  }

  const orderKey = `order:${orderNumber}`;
  const existingOrder = await getJson(env.KV, orderKey);

  if (existingOrder?.status === 'paid' && existingOrder.licenseKey) {
    return json({ success: true, license: existingOrder.licenseKey, alreadyCreated: true });
  }

  const paymentKey = `payment:${orderNumber}`;
  const existingPayment = await getJson(env.KV, paymentKey);

  if (existingPayment?.license) {
    return json({ success: true, license: existingPayment.license, alreadyCreated: true });
  }

  const licenseKey = generateLicenseKey();
  const downloadToken = generateToken();
  const now = Date.now();

  await env.KV.put(
    licenseStorageKey(licenseKey),
    JSON.stringify({
      license: licenseKey,
      devices: [],
      createdAt: now,
      status: 'active',
      orderNumber,
    }),
  );

  await env.KV.put(
    `dl:${downloadToken}`,
    JSON.stringify({
      licenseKey,
      used: false,
      expires: now + DOWNLOAD_TTL_SECONDS * 1000,
    }),
    { expirationTtl: DOWNLOAD_TTL_SECONDS },
  );

  await env.KV.put(
    orderKey,
    JSON.stringify({
      status: 'paid',
      licenseKey,
      downloadToken,
      createdAt: existingOrder?.createdAt || now,
      paidAt: now,
    }),
    { expirationTtl: ORDER_TTL_SECONDS },
  );

  await env.KV.put(
    paymentKey,
    JSON.stringify({
      license: licenseKey,
      createdAt: now,
    }),
    { expirationTtl: ORDER_TTL_SECONDS },
  );

  return json({ success: true, license: licenseKey });
}

/* ============================================================
   POST /api/activate
   Input: { license, device }
   - same device: success, no new record
   - new device below limit: add device, success
   - third device: activation limit reached
   ============================================================ */
async function activate(request, env) {
  const body = await readJson(request);
  const inputError = validateLicenseDeviceInput(body);

  if (inputError) {
    return inputError;
  }

  const licenseKey = normalizeLicense(body.license);
  const deviceId = normalizeDevice(body.device);
  const storedLicense = await getLicense(env, licenseKey);

  if (!storedLicense) {
    return json({ success: false, error: 'license not found' }, 404);
  }

  const license = normalizeLicenseRecord(storedLicense, licenseKey);

  if (license.status !== 'active') {
    return json({ success: false, error: 'license inactive' }, 403);
  }

  if (license.devices.some((device) => device.id === deviceId)) {
    return json({
      success: true,
      activated: true,
      alreadyActivated: true,
      remaining: MAX_DEVICES - license.devices.length,
    });
  }

  if (license.devices.length >= MAX_DEVICES) {
    return json({ success: false, error: 'activation limit reached' }, 403);
  }

  license.devices.push({
    id: deviceId,
    activatedAt: Date.now(),
  });

  await putLicense(env, license);

  return json({
    success: true,
    activated: true,
    remaining: MAX_DEVICES - license.devices.length,
  });
}

/* ============================================================
   POST /api/validate
   Input: { license, device }
   Does not activate new devices.
   ============================================================ */
async function validate(request, env) {
  const body = await readJson(request);
  const inputError = validateLicenseDeviceInput(body);

  if (inputError) {
    return json({ valid: false, reason: 'invalid request' }, 400);
  }

  const licenseKey = normalizeLicense(body.license);
  const deviceId = normalizeDevice(body.device);
  const storedLicense = await getLicense(env, licenseKey);

  if (!storedLicense) {
    return json({ valid: false, reason: 'license not found' });
  }

  const license = normalizeLicenseRecord(storedLicense, licenseKey);

  if (license.status !== 'active') {
    return json({ valid: false, reason: 'license inactive' });
  }

  if (!license.devices.some((device) => device.id === deviceId)) {
    return json({ valid: false, reason: 'device not activated' });
  }

  return json({ valid: true });
}

/* ============================================================
   POST /admin/reset or /api/admin/reset
   Input: { license }
   Auth: x-admin-token or Authorization: Bearer ADMIN_TOKEN
   Also accepts legacy body token for manual calls.
   ============================================================ */
async function adminReset(request, env) {
  const body = await readJson(request);
  const adminToken =
    request.headers.get('x-admin-token') ||
    parseBearerToken(request.headers.get('authorization')) ||
    String(body?.token || '');

  if (!env.ADMIN_TOKEN || adminToken !== env.ADMIN_TOKEN) {
    return json({ success: false, error: 'unauthorized' }, 401);
  }

  const licenseValidation = validateLicenseInput(body);

  if (licenseValidation) {
    return licenseValidation;
  }

  const licenseKey = normalizeLicense(body.license);
  const storedLicense = await getLicense(env, licenseKey);

  if (!storedLicense) {
    return json({ success: false, error: 'license not found' }, 404);
  }

  const license = normalizeLicenseRecord(storedLicense, licenseKey);
  license.devices = [];

  await putLicense(env, license);

  return json({ success: true, reset: true });
}

/* ============================================================
   GET /api/test
   Creates a test paid order and test license for manual smoke testing.
   ============================================================ */
async function createTestOrder(env) {
  const orderNumber = `test-${Date.now()}`;
  const licenseKey = 'ILBL-TEST-AAAA-BBBB';

  const existing = await getLicense(env, licenseKey);

  if (!existing) {
    await putLicense(env, {
      license: licenseKey,
      devices: [],
      createdAt: Date.now(),
      status: 'active',
      orderNumber,
    });
  }

  await env.KV.put(
    `order:${orderNumber}`,
    JSON.stringify({
      status: 'paid',
      licenseKey,
      downloadToken: 'testtoken123',
      createdAt: Date.now(),
    }),
    { expirationTtl: 60 * 60 },
  );

  return Response.redirect(`https://ilabels.iosflowzy.workers.dev/success.html?order=${orderNumber}`, 302);
}

/* ============================================================
   Helpers
   ============================================================ */
function normalizePath(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  return path;
}

function generateOrderId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segment = () => {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => chars[byte % chars.length]).join('');
  };

  return `ILBL-${segment()}-${segment()}-${segment()}`;
}

function mapStatus(status) {
  return ['completed', 'success', 'paid', 'mismatch'].includes(String(status || '').toLowerCase()) ? 'paid' : 'other';
}

async function getLicense(env, licenseKey) {
  return getJson(env.KV, licenseStorageKey(licenseKey));
}

async function putLicense(env, license) {
  await env.KV.put(licenseStorageKey(license.license), JSON.stringify(license));
}

function licenseStorageKey(licenseKey) {
  return `license:${normalizeLicense(licenseKey)}`;
}

async function getJson(kv, key) {
  const raw = await kv.get(key);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function normalizeLicenseRecord(record, licenseKey) {
  const devices = Array.isArray(record.devices)
    ? record.devices.map((device) => (typeof device === 'string' ? { id: device, activatedAt: record.createdAt || Date.now() } : device))
    : [];

  return {
    ...record,
    license: normalizeLicense(record.license || licenseKey),
    devices: devices.filter((device) => device && typeof device.id === 'string' && device.id.length > 0),
    createdAt: record.createdAt || Date.now(),
    status: record.status || 'active',
  };
}

function validateLicenseDeviceInput(body) {
  return validateLicenseInput(body) || validateDeviceInput(body);
}

function validateLicenseInput(body) {
  if (!body || typeof body !== 'object') {
    return json({ success: false, error: 'invalid json body' }, 400);
  }

  if (!LICENSE_KEY_PATTERN.test(normalizeLicense(body.license))) {
    return json({ success: false, error: 'invalid license' }, 400);
  }

  return null;
}

function validateDeviceInput(body) {
  const device = normalizeDevice(body.device);

  if (!device || device.length > 200) {
    return json({ success: false, error: 'invalid device' }, 400);
  }

  return null;
}

function normalizeLicense(license) {
  return String(license || '').trim().toUpperCase();
}

function normalizeDevice(device) {
  return String(device || '').trim();
}

function parseBearerToken(value) {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    return null;
  }
}

async function readBody(request) {
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    return Object.fromEntries(formData.entries());
  }

  return readJson(request);
}

async function verifyPlisio(body, secret) {
  if (!body.verify_hash) {
    return false;
  }

  const payload = { ...body };
  const verifyHash = String(payload.verify_hash);
  delete payload.verify_hash;

  const postString = phpSerializeObject(sortObject(payload));
  const expected = await hmacSha1(postString, secret);

  return timingSafeEqual(expected, verifyHash);
}

function sortObject(value) {
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = String(value[key]);
      return result;
    }, {});
}

function phpSerializeObject(value) {
  const entries = Object.entries(value);
  const serializedEntries = entries.map(([key, entryValue]) => `${phpSerializeString(key)}${phpSerializeString(entryValue)}`).join('');
  return `a:${entries.length}:{${serializedEntries}}`;
}

function phpSerializeString(value) {
  const stringValue = String(value);
  return `s:${new TextEncoder().encode(stringValue).length}:"${stringValue}";`;
}

async function hmacSha1(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left, right) {
  const leftValue = String(left);
  const rightValue = String(right);

  if (leftValue.length !== rightValue.length) {
    return false;
  }

  let diff = 0;

  for (let index = 0; index < leftValue.length; index += 1) {
    diff |= leftValue.charCodeAt(index) ^ rightValue.charCodeAt(index);
  }

  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(CORS).forEach(([key, value]) => headers.set(key, value));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
