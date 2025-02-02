import { Cookie, firefox } from 'playwright';
import fs from 'fs';
import fsExtra from 'fs-extra';
import minimist from 'minimist';
import cliProgress from 'cli-progress';
import ansiColors from 'ansi-colors';

const COOKIES_FILE_PATH = './cookies.json';

function loadSavedCookies() {
  const existingCookies: Cookie[] = [];
  if (fs.existsSync(COOKIES_FILE_PATH)) {
    existingCookies.push(
      ...JSON.parse(
        fs.readFileSync(COOKIES_FILE_PATH, {
          encoding: 'utf8',
          flag: 'r',
        })
      )
    );
  }
  return existingCookies;
}

function saveCookies(cookies: Cookie[]) {
  fs.writeFileSync(COOKIES_FILE_PATH, JSON.stringify(cookies, null, '\t'), {
    encoding: 'utf-8',
    flag: 'w',
  });
}

async function preloadCookies(url: string, existingCookies: Cookie[]) {
  const browser = await firefox.launch({
    headless: false,
  });
  const context = await browser.newContext();
  await context.addCookies(existingCookies);
  const page = await context.newPage();
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
  });

  let initial = false;
  while ((await page.locator('title').innerText()) === 'Just a moment...') {
    if (!initial) {
      initial = true;
      console.log('is in cloudflare!');
      console.log('complete the captcha or close the program and manually import valid cookies in the "cookies.json" file.');
    }
    await page.waitForURL('https://sushiscan.net/**', {
      waitUntil: 'domcontentloaded',
    });
  }

  const cookies = await context.cookies();
  await browser.close();
  return cookies;
}

async function downloadWithRetry(
  context: any,
  imageUrl: string,
  folder: string,
  name: string,
  bar1: any,
  destinationFolder: string
): Promise<void> {
  while (true) {
    try {
      const response = await context.request.get(imageUrl);
      if (response.ok()) {
        const body = await response.body();
        fsExtra.outputFileSync(`${destinationFolder}/${folder}/${name}.jpg`, body);
        bar1.increment();
        return;
      } else {
        throw new Error(`HTTP status ${response.status()}`);
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Failed to download ${imageUrl}: ${errorMessage}. Retrying in 10s...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}

async function downloadingSushiscanPageImages(url: string, destinationFolder: string) {
  console.log('preloading cookies');
  const preloadedCookies = await preloadCookies(url, loadSavedCookies());
  console.log('saving loaded cookies');
  saveCookies(preloadedCookies);

  const browser = await firefox.launch();
  const context = await browser.newContext();
  await context.addCookies(preloadedCookies);
  const page = await context.newPage();
  await page.setViewportSize({
    width: 1920,
    height: 1080,
  });
  await page.addInitScript(() => {
    localStorage.setItem('tsms_readingmode', '"full"');
  });

  console.log('loading page... (waiting for the page to stabilize, might take up to a minute)\n');

  const bar1 = new cliProgress.SingleBar(
    {
      barCompleteChar: ansiColors.magenta('#'),
      barIncompleteChar: '.',
      fps: 5,
      stream: process.stdout,
      barsize: 65,
    },
    cliProgress.Presets.shades_classic
  );

  const urlPassed: string[] = [];
  const downloadPromises: Promise<void>[] = [];
  let taille = 0;

  page.on('response', async (response) => {
    if (response.ok() && response.url() === (url.endsWith('/') ? url : url + '/')) {
      const [_, images] = (await response.text()).match(/"images":\s?\[([^\]]*)\]/) as RegExpMatchArray;
      taille = images.split(',').length;
      bar1.start(taille, 0);
    }

    if (response.ok() && response.url().match(/wp-content\/upload.+-\d+\.\w+$/) && !urlPassed.includes(response.url())) {
      const imageUrl = response.url();
      urlPassed.push(imageUrl);
      const [_, folder, name] = imageUrl.match(/\/([^/-]+)-(\d+)\.\w+$/) as RegExpMatchArray;

      downloadPromises.push(downloadWithRetry(context, imageUrl, folder, name, bar1, destinationFolder));
    }
  });

  await page.goto(url, {
    waitUntil: 'networkidle',
    timeout: 120000,
  });

  await (
    await page.locator('#readerarea>img').all()
  ).reduce<Promise<any>>(async (previousValue, l) => {
    return previousValue
      .then(() => l.evaluate((img: any) => img.scrollIntoView()))
      .then(() => page.waitForLoadState('networkidle'));
  }, Promise.resolve());

  await page.waitForLoadState('networkidle');
  console.log('\nWaiting for all downloads to complete...');
  await Promise.all(downloadPromises);
  console.log('\nDownload complete!');
  bar1.stop();

  await browser.close();
}

const processArgs = minimist(process.argv.slice(2));
console.log(processArgs);
if (processArgs['h'] || processArgs['help']) {
  console.log('-h, --help : help');
  console.log('-----------------');
  console.log('<sushiscan-url> : Sushiscan url to download');
  console.log('-d : destination folder (optional)');
}
const destinationFolder: string = processArgs['d'] || './dl';
fsExtra.ensureDirSync(destinationFolder);

const url: string = processArgs['_'][0];
if (!url) {
  console.log('url required, type -h to know more');
  process.exit(1);
}

downloadingSushiscanPageImages(url, destinationFolder);
