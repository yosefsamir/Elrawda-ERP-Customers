const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const action = process.argv[2] || 'status';
  const base = `http://127.0.0.1:${process.env.WHATSAPP_TEST_PORT || 3210}`;
  const page = await (await fetch(base)).text();
  const token = page.match(/name="local-test-token" content="([a-f0-9]+)"/)?.[1];
  if (!token) throw new Error('Local test server not available.');
  const input = {};
  if (['probe', 'source'].includes(action) && process.argv[3]) input.moduleName = process.argv[3];
  if (action === 'add') {
    const target = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../data/whatsapp-test/lab-target.json'), 'utf8'));
    input.phone = target.phone;
    input.confirmed = true;
  }
  const response = await fetch(`${base}/api/lab/${action}`, {
    method: 'POST', headers: { 'X-Local-Test-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  const result = await response.json();
  console.log(JSON.stringify(result, (key, value) => ['phone', 'targetPhone', 'targetId'].includes(key) ? '[private]' : value, 2));
  if (!response.ok) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
