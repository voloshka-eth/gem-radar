const fs = require('fs');
const crypto = require('crypto');

const env = { ...process.env };
try {
  const lines = fs.readFileSync('.env', 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && !env[match[1]]) {
      env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch {
  // .env is optional for CI.
}

async function main() {
  const baseUrl = env.GOPLUS_BASE_URL || 'https://api.gopluslabs.io';
  const appKey = env.GOPLUS_APP_KEY || env.GOPLUS_API_KEY;
  const appSecret = env.GOPLUS_APP_SECRET;
  const out = { hasAppKey: Boolean(appKey), hasSecret: Boolean(appSecret) };

  if (!appKey || !appSecret) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const time = Math.floor(Date.now() / 1000).toString();
  const sign = crypto.createHash('sha1').update(`${appKey}${time}${appSecret}`).digest('hex');
  let token = '';

  const authAttempts = [
    {
      label: 'json',
      url: `${baseUrl}/api/v1/token_security/access_token`,
      options: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_key: appKey, time, sign }),
      },
    },
    {
      label: 'query',
      url: `${baseUrl}/api/v1/token_security/access_token?app_key=${encodeURIComponent(appKey)}&time=${time}&sign=${sign}`,
      options: { method: 'POST' },
    },
    {
      label: 'form',
      url: `${baseUrl}/api/v1/token_security/access_token`,
      options: {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ app_key: appKey, time, sign }).toString(),
      },
    },
  ];
  out.authAttempts = [];
  for (const attempt of authAttempts) {
    try {
      const authRes = await fetch(attempt.url, attempt.options);
      const authJson = await authRes.json().catch(() => ({}));
      const attemptToken =
        authJson.result?.access_token ??
        authJson.result?.token ??
        authJson.access_token ??
        authJson.token ??
        '';
      out.authAttempts.push({
        label: attempt.label,
        http: authRes.status,
        code: authJson.code,
        message: authJson.message,
        tokenReceived: Boolean(attemptToken),
      });
      if (attemptToken) {
        token = attemptToken;
        break;
      }
    } catch (err) {
      out.authAttempts.push({ label: attempt.label, error: err.message });
    }
  }
  out.authTokenReceived = Boolean(token);

  try {
    const addr = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
    const riskRes = await fetch(
      `${baseUrl}/api/v1/token_security/1?contract_addresses=${addr}`,
      token ? { headers: { Authorization: token } } : {},
    );
    const riskJson = await riskRes.json().catch(() => ({}));
    const key = Object.keys(riskJson.result || {})[0];
    const payload = key ? riskJson.result[key] : {};
    const fields = [
      'is_honeypot',
      'is_mintable',
      'is_blacklisted',
      'is_proxy',
      'buy_tax',
      'sell_tax',
      'can_take_back_ownership',
      'transfer_pausable',
      'owner_address',
      'creator_address',
      'cannot_sell_all',
      'is_in_dex',
    ];

    out.riskHttp = riskRes.status;
    out.riskCode = riskJson.code;
    out.riskMessage = riskJson.message;
    out.resultKeys = Object.keys(riskJson.result || {}).length;
    out.presentRiskFields = fields.filter(
      (field) => payload[field] !== undefined && payload[field] !== null && payload[field] !== '',
    );
    out.fieldCount = Object.keys(payload || {}).length;
  } catch (err) {
    out.riskError = err.message;
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
