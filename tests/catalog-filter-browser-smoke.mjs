import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../dist/runtime/apps/server/image-processing/config.js';

// Isolated built-artifact QA: never connects to ERP or the user's running app.
const { demoCatalog, demoLocations } = await import('../apps/reports/src/demo/catalog.ts');
const root = resolve('dist/reports');
const screenshots = resolve('.cache/reports-filter');
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ executablePath: resolveChromiumExecutable(), headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://reports.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/reports/filter-options') return route.fulfill({ json: { nodes: demoCatalog, locations: demoLocations, source: { label: 'اختبار', readAt: new Date().toISOString() } } });
    assert.ok(url.pathname.startsWith('/reports/'), `Unexpected request: ${url.pathname}`);
    const file = url.pathname === '/reports/' ? 'index.html' : decodeURIComponent(url.pathname.slice('/reports/'.length));
    assert.ok(!file.includes('..'));
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ttf': 'font/ttf' }[extname(file)];
    await route.fulfill({ body: await readFile(resolve(root, file)), contentType: mime ?? 'application/octet-stream' });
  });
  const visit = async () => { await page.goto('http://reports.test/reports/'); await page.getByRole('heading', { name: 'حدد نطاق الاختيار' }).waitFor(); await page.getByRole('button', { name: 'تطبيق الفلاتر' }).waitFor(); await page.evaluate(() => document.fonts.ready); };
  await visit();
  await page.screenshot({ path: resolve(screenshots, 'desktop.png'), fullPage: true });
  await page.getByRole('combobox', { name: 'النوع', exact: true }).click();
  await page.getByRole('option', { name: 'ملابس', exact: true }).click();
  // An unselected intermediate level must not remove the selected ancestor's scope.
  for (const label of ['التصنيف', 'المقاس / الوصف', 'كود الموديل']) {
    await page.getByRole('combobox', { name: label, exact: true }).click();
    const options = await page.getByRole('listbox', { name: label, exact: true }).getByRole('option').allTextContents();
    assert.ok(options.length > 0);
    assert.ok(options.every(text => text.includes('ملابس') && !text.includes('أحذية') && !text.includes('إكسسوار')), `Ancestor scope lost at ${label}: ${options}`);
    await page.keyboard.press('Escape');
  }
  // Field search matches its own labels, never ancestor descriptions.
  for (const [label, ancestor, ownLabel] of [
    ['القسم', 'ملابس', 'بنطلون'],
    ['التصنيف', 'بنطلون', 'جينز'],
    ['المقاس / الوصف', 'بنطلون', 'قصة مستقيمة'],
    ['كود الموديل', 'بنطلون', 'D1501'],
  ]) {
    const field = page.getByRole('combobox', { name: label, exact: true });
    await field.fill(ancestor);
    assert.equal(await page.getByRole('listbox', { name: label, exact: true }).getByRole('option').count(), 0, `${label} matched an ancestor description`);
    await field.fill(ownLabel);
    assert.ok(await page.getByRole('listbox', { name: label, exact: true }).getByRole('option').count() > 0, `${label} didn't match its own label`);
    await page.keyboard.press('Escape');
  }
  await page.getByRole('combobox', { name: 'بحث سريع في الشجرة', exact: true }).fill('أحذية');
  assert.equal(await page.getByRole('listbox', { name: 'بحث سريع في الشجرة', exact: true }).getByRole('option').count(), 0);
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'القسم', exact: true }).click();
  assert.deepEqual(await page.getByRole('listbox', { name: 'القسم', exact: true }).getByRole('option').allTextContents(), ['بنطلون', 'قميص', 'تيشيرت']);
  await page.getByRole('option', { name: 'بنطلون', exact: true }).click();
  await page.getByRole('combobox', { name: 'التصنيف', exact: true }).click();
  await page.getByRole('option', { name: 'جينز', exact: true }).click();
  await page.getByRole('combobox', { name: 'النوع', exact: true }).click();
  await page.getByRole('option', { name: 'أحذية', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'القسم', exact: true }).inputValue(), '');
  assert.equal(await page.getByRole('combobox', { name: 'التصنيف', exact: true }).inputValue(), '');
  await page.getByRole('combobox', { name: 'القسم', exact: true }).click();
  assert.deepEqual(await page.getByRole('listbox', { name: 'القسم', exact: true }).getByRole('option').allTextContents(), ['كوتشي', 'حذاء']);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'إعادة ضبط', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'بحث سريع في الشجرة', exact: true });
  await search.fill('جبردين');
  await search.press('ArrowDown'); await search.press('Enter');
  assert.equal(await page.getByRole('combobox', { name: 'النوع', exact: true }).inputValue(), 'ملابس');
  assert.equal(await page.getByRole('combobox', { name: 'القسم', exact: true }).inputValue(), 'بنطلون');
  assert.equal(await search.getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: 'أضف مسارًا آخر', exact: true }).click();
  await page.getByRole('combobox', { name: 'النوع', exact: true }).click();
  await page.getByRole('option', { name: 'أحذية', exact: true }).click();
  assert.equal(await page.locator('.rf-scope-chip').count(), 2);
  await page.getByRole('button', { name: 'إعادة ضبط', exact: true }).click();
  await page.getByRole('button', { name: 'تصفح الشجرة', exact: true }).click();
  const tree = page.getByRole('dialog');
  await tree.getByRole('checkbox', { name: 'تحديد كل الأصناف', exact: true }).uncheck();
  await tree.getByRole('checkbox', { name: 'تحديد ملابس', exact: true }).check();
  await tree.getByRole('button', { name: 'فتح بنطلون', exact: true }).click();
  await tree.getByRole('checkbox', { name: 'تحديد ملابس / بنطلون / جينز', exact: true }).uncheck();
  assert.equal(await tree.getByRole('checkbox', { name: 'تحديد ملابس', exact: true }).getAttribute('aria-checked'), 'mixed');
  await tree.getByRole('button', { name: 'اعتماد التحديد', exact: true }).click();
  assert.equal(await tree.count(), 0);
  await page.getByRole('button', { name: /^الفروع / }).click();
  await page.getByRole('button', { name: 'إلغاء التحديد', exact: true }).click();
  await page.getByRole('checkbox', { name: 'المنصورة', exact: true }).check();
  await page.getByRole('checkbox', { name: 'شربين', exact: true }).check();
  await page.getByRole('button', { name: 'تم الاختيار', exact: true }).click();
  await page.getByRole('button', { name: /^المخازن / }).click();
  assert.deepEqual(await page.locator('.rf-multi-options .rf-check-option strong').allTextContents(), ['مخزن المنصورة', 'مخزن شربين']);
  await page.getByRole('button', { name: 'تم الاختيار', exact: true }).click();
  await page.getByRole('button', { name: 'تطبيق الفلاتر', exact: true }).click();
  await page.getByRole('status').waitFor();
  await page.screenshot({ path: resolve(screenshots, 'desktop-selected.png'), fullPage: true });
  for (const width of [360, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 }); await visit();
    const overflow = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    assert.ok(overflow.body <= overflow.viewport, `Horizontal overflow at ${width}: ${JSON.stringify(overflow)}`);
    await page.getByRole('combobox', { name: 'القسم', exact: true }).click();
    const menu = await page.locator('.rf-select-menu').boundingBox();
    assert.ok(menu && menu.x >= 0 && menu.x + menu.width <= width + 1, `Dropdown overflow at ${width}`);
    await page.keyboard.press('Escape');
    if (width === 390) await page.screenshot({ path: resolve(screenshots, 'mobile.png'), fullPage: true });
    await page.getByRole('button', { name: 'تصفح الشجرة', exact: true }).click();
    const dialogBox = await page.getByRole('dialog').boundingBox();
    assert.ok(dialogBox && dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= width + 1, `Tree overflow at ${width}`);
    if (width === 390) await page.screenshot({ path: resolve(screenshots, 'mobile-tree.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: cascade, direct autocomplete, multiple scopes, partial tree selection, branches/stores, apply, keyboard and five responsive widths.');
  console.log(`Screenshots: ${screenshots}`);
} finally { await browser.close(); }
