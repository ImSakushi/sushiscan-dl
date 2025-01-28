import { Cookie, firefox } from 'playwright';
import fs from 'fs';
import fsExtra from 'fs-extra';
import minimist from 'minimist';
import cliProgress from 'cli-progress';
import ansiColors from 'ansi-colors';

const COOKIES_FILE_PATH = './cookies.json';

function loadSavedCookies(): Cookie[] {
  const existingCookies: Cookie[] = [];
  if (fs.existsSync(COOKIES_FILE_PATH)) {
    try {
      const cookiesData = fs.readFileSync(COOKIES_FILE_PATH, 'utf8');
      existingCookies.push(...JSON.parse(cookiesData));
      console.log(`${ansiColors.green('✓')} ${existingCookies.length} cookies chargés depuis le cache`);
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(`${ansiColors.red('✗')} Erreur de lecture des cookies : ${error.message}`);
      } else {
        console.error(`${ansiColors.red('✗')} Erreur de lecture des cookies : Une erreur inconnue est survenue`);
      }
    }
  }
  return existingCookies;
}

function saveCookies(cookies: Cookie[]): void {
  try {
    fs.writeFileSync(COOKIES_FILE_PATH, JSON.stringify(cookies, null, 2), 'utf8');
    console.log(`${ansiColors.green('✓')} ${cookies.length} cookies sauvegardés`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`${ansiColors.red('✗')} Erreur de sauvegarde des cookies : ${error.message}`);
    } else {
      console.error(`${ansiColors.red('✗')} Erreur de sauvegarde des cookies : Une erreur inconnue est survenue`);
    }
  }
}

async function preloadCookies(url: string, existingCookies: Cookie[]): Promise<Cookie[]> {
  console.log('\nValidation des cookies...');
  const browser = await firefox.launch({ headless: false });
  const context = await browser.newContext();
  await context.addCookies(existingCookies);

  const page = await context.newPage();
  let attempts = 0;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    while ((await page.locator('title').innerText()) === 'Just a moment...' && attempts < 5) {
      if (attempts === 0) {
        console.log(`${ansiColors.yellow('⚠')} Cloudflare détecté :`);
        console.log('1. Complétez le captcha manuellement');
        console.log('2. Attendez le chargement de la page');
        console.log('3. Le programme continuera automatiquement\n');
      }

      attempts++;
      await page.waitForURL('https://sushiscan.net/**', { timeout: 120000 });
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`${ansiColors.red('✗')} Échec de la validation des cookies : ${error.message}`);
    } else {
      console.error(`${ansiColors.red('✗')} Échec de la validation des cookies : Une erreur inconnue est survenue`);
    }
    process.exit(1);
  } finally {
    const cookies = await context.cookies();
    await browser.close();
    return cookies;
  }
}

async function downloadWithRetry(
  context: any,
  imageUrl: string,
  folder: string,
  name: string,
  bar: cliProgress.SingleBar,
  destinationFolder: string
): Promise<void> {
  let attempts = 0;
  const maxLoggedAttempts = 3;
  const startTime = Date.now();

  while (true) {
    try {
      const response = await context.request.get(imageUrl);
      if (!response.ok()) throw new Error(`Statut HTTP ${response.status()}`);

      const buffer = await response.body();
      fsExtra.outputFileSync(`${destinationFolder}/${folder}/${name}.jpg`, buffer);

      if (attempts > 0) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        bar.update(1, { suffix: `${ansiColors.green('✓')} ${imageUrl} (réussi après ${attempts} essais, ${duration}s)\n` });
      }
      return;
    } catch (error) {
      attempts++;
      if (attempts <= maxLoggedAttempts) {
        bar.update({ suffix: `${ansiColors.yellow('⚠')} [Essai ${attempts}] ${imageUrl}: ${(error as Error).message}\n` });
      } else if (attempts === maxLoggedAttempts + 1) {
        bar.update({ suffix: `${ansiColors.yellow('⚠')} Réessais silencieux activés pour ${imageUrl}...\n` });
      }
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
}

async function downloadingSushiscanPageImages(url: string, destinationFolder: string): Promise<void> {
  console.log(ansiColors.cyan('\n=== Démarrage du téléchargement ==='));
  console.log(`${ansiColors.cyan('URL:')} ${ansiColors.underline(url)}`);
  console.log(`${ansiColors.cyan('Destination:')} ${ansiColors.underline(destinationFolder)}\n`);

  // Gestion des cookies
  const existingCookies = loadSavedCookies();
  const validCookies = await preloadCookies(url, existingCookies);
  saveCookies(validCookies);

  // Configuration du navigateur
  const browser = await firefox.launch();
  const context = await browser.newContext();
  await context.addCookies(validCookies);

  const page = await context.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    localStorage.setItem('tsms_readingmode', '"full"');
  });

  // Configuration de la barre de progression
  const progressBar = new cliProgress.SingleBar(
    {
      format: `${ansiColors.magenta('{bar}')} {percentage}% | ETA: {eta}s | {value}/{total} | {suffix}`,
      barCompleteChar: '#',
      barIncompleteChar: '.',
      barsize: 50,
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );

  let totalImages = 0;
  const downloadQueue: Promise<void>[] = [];
  const processedUrls = new Set<string>();

  // Gestion des réponses
  page.on('response', async (response) => {
    try {
      // Détection du nombre d'images
      if (response.url() === url && response.ok()) {
        const body = await response.text();
        const match = body.match(/"images":\s?\[([^\]]*)\]/);
        if (!match) throw new Error('Format de réponse inattendu');

        totalImages = match[1].split(',').length;
        console.log(`${ansiColors.green('✓')} ${totalImages} images détectées`);
        progressBar.start(totalImages, 0, { suffix: 'Initialisation...' });
      }

      // Téléchargement des images
      if (response.url().match(/wp-content\/upload.+-\d+\.\w+$/) && !processedUrls.has(response.url())) {
        processedUrls.add(response.url());
        const [_, folder, name] = response.url().match(/\/([^/-]+)-(\d+)\.\w+$/) as RegExpMatchArray;

        downloadQueue.push(
          downloadWithRetry(context, response.url(), folder, name, progressBar, destinationFolder).then(() =>
            progressBar.increment()
          )
        );
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(`${ansiColors.red('✗')} Erreur de traitement : ${error.message}`);
      } else {
        console.error(`${ansiColors.red('✗')} Erreur de traitement : ${String(error)}`);
      }
    }
  });

  // Navigation principale
  try {
    console.log('\nChargement de la page...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });

    // Défilement pour charger toutes les images
    console.log('\nChargement des images...');
    const images = await page.locator('#readerarea>img').all();
    for (const [index, img] of images.entries()) {
      progressBar.update({ suffix: `Image ${index + 1}/${images.length}` });
      await img.evaluate((element: HTMLElement) => element.scrollIntoView());
      await page.waitForLoadState('networkidle');
    }

    // Attente de la fin des téléchargements
    console.log('\nFinalisation des téléchargements...');
    await Promise.all(downloadQueue);

    console.log(`\n${ansiColors.bold.green('✓ Téléchargement terminé avec succès !')}`);
    console.log(`${ansiColors.italic('Les images sont disponibles dans :')} ${ansiColors.underline(destinationFolder)}`);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`\n${ansiColors.red('✗ Erreur critique :')} ${error.message}`);
      console.error(`${ansiColors.red('Stack trace :')}\n${error.stack}`);
    } else {
      console.error(`\n${ansiColors.red('✗ Erreur critique :')} ${String(error)}`);
    }
    process.exit(1);
  } finally {
    progressBar.stop();
    await browser.close();
  }
}

// Gestion des arguments
const args = minimist(process.argv.slice(2));
if (args.h || args.help) {
  console.log(`
${ansiColors.bold('Utilisation :')}
  npm run start -- [URL] [-d DOSSIER]

${ansiColors.bold('Options :')}
  -d, --dest    Dossier de destination (par défaut : ./dl)
  -h, --help    Affiche cette aide
  `);
  process.exit(0);
}

// Validation des paramètres
const destination = args.d || args.dest || './dl';
const targetUrl = args._[0];

if (!targetUrl) {
  console.error(`${ansiColors.red('✗ URL manquante !')}`);
  process.exit(1);
}

fsExtra.ensureDirSync(destination);
downloadingSushiscanPageImages(targetUrl, destination).catch((error) => {
  console.error(`${ansiColors.red('✗ Erreur non gérée :')} ${error.message}`);
  process.exit(1);
});
