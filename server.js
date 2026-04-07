import { resolve, dirname } from 'path';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { Telegraf } from 'telegraf';

class BoundedSet {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.set = new Set();
  }
  add(value) {
    if (this.set.has(value)) return this;
    if (this.set.size >= this.maxSize) {
      const firstValue = this.set.values().next().value;
      this.set.delete(firstValue);
    }
    this.set.add(value);
    return this;
  }
  has(value) { return this.set.has(value); }
  delete(value) { return this.set.delete(value); }
  clear() { this.set.clear(); }
  get size() { return this.set.size; }
  values() { return this.set.values(); }
  keys() { return this.set.keys(); }
  entries() { return this.set.entries(); }
  forEach(cb) { this.set.forEach(cb); }
  [Symbol.iterator]() { return this.set[Symbol.iterator](); }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const NOTIFY_REQS_FILE_NAME = 'notify-reqs.json';
const FETCH_TIMEOUT_MS = 10000;
const ALERTS_CACHE_SIZE = 10000;

let notifyReqs = [];
let checkAlertsIntervalMs = 10000;
let bot = null;
const alertKeys = new BoundedSet(ALERTS_CACHE_SIZE);

function loadEnvVars() {
    const ENV_PATH = resolve(__dirname, '.env');
    const envLoadResult = loadEnv({path: ENV_PATH});
    if (envLoadResult.error && envLoadResult.error.code !== 'ENOENT') {
        throw new Error(
            `[config] Failed to load .env file at ${ENV_PATH}: ${envLoadResult.error.message}`,
        );
    }
    const parsedEnv = envLoadResult.parsed ?? {};
    const requireEnvVar = (key) => {
        const value = process.env[key] ?? parsedEnv[key];
        if (value === undefined) {
            throw new Error(
                `[config] Missing ${key}. Set it in environment variables (CI) or .env (${ENV_PATH}).`,
            );
        }
        return value;
    };
    return {
        envVarCheckAlertsIntervalMs: requireEnvVar('CHECK_ALERTS_INTERVAL_MS'),
        envVarBotToken: requireEnvVar('BOT_TOKEN'),
    }
}

function readDataObjectFromFile(dirPath, fileName, noFileSefault) {
    let dataObject = null;
    const fullFilePath = `${dirPath}/${fileName}`;
    try {
        const outDir = resolve(__dirname, dirPath);
        const raw = readFileSync(resolve(outDir, fileName), 'utf8');
        dataObject = JSON.parse(raw);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return noFileSefault;
        }
        console.warn(`Error while trying to read from ${fullFilePath}`, error);
    }
    return dataObject;
}

/*
function writeDataObjectToFile(dataObject, dirPath, fileName) {
    const fullFilePath = `${dirPath}/${fileName}`;
    try {
        const outDir = resolve(__dirname, dirPath);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(resolve(outDir, fileName), JSON.stringify(dataObject, null, 2));
        return true;
    } catch (error) {
        console.error(`Error while trying to write to ${fullFilePath}`, error);
        return false;
    }
}
*/

async function fetchWithTimeout(url, fetchTimeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchAlertsHistory() {
    let alerts = [];
    const url = `https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json`;
    try {
        const response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
        if (response.ok) {
            alerts = await response.json();                
        } else {
            console.error(`Error fetching alerts history!`, response.status, response.statusText);
        }
    } catch {}
    alerts.sort((a, b) => new Date(a.alertDate) - new Date(b.alertDate));
    return alerts;
}

const getAlertKey = alert => `${alert.alertDate}|${alert.data}|${alert.category}`;

function initTelegramBot(botToken) {
    console.log(`Bot initializing...`);
    const bot = new Telegraf(botToken);
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    console.log(`Bot initialized.`);
    return bot;
}

async function postToTelegram(bot, chatId, msgs) {
    try {
        console.log(`Posting ${msgs.length} messages to Telegram channel ${chatId}...`);
        console.log(msgs);
        await bot.telegram.sendMessage(chatId, msgs.join('\n\n')).catch(console.error);
    } catch (error) {
        console.error('Failed posting to Telegram!', error);
    }
}

function getIsrDayAndHour() {
    const now = new Date();
    const threeLetterDay = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'Asia/Jerusalem' });
    const twoDigitHour = parseInt(now.toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' }));
    return {
        threeLetterDay,
        twoDigitHour
    }
}

async function checkAlerts(shouldPostAlerts = true) {
    const newAlerts = [];
    const fetchedAlerts = await fetchAlertsHistory();
    for (let a of fetchedAlerts) {
        const alertKey = getAlertKey(a);
        if (alertKeys.has(alertKey)) {
            continue;
        }
        alertKeys.add(alertKey);
        newAlerts.push(a);
    }

    if (newAlerts.length > 0 && shouldPostAlerts) {
        const {threeLetterDay, twoDigitHour} = getIsrDayAndHour();
        for (let r of notifyReqs) {
            r.curSchedules = r.schedule.filter(s => s.days.includes(threeLetterDay) && s.hours.includes(twoDigitHour));
            r.curEvents = new Map();
            for (let a of newAlerts) {
                for (let s of r.curSchedules) {
                    if (!s.locations.includes(a.data)) {
                        continue;
                    }
                    //const time = a.alertDate.split(' ')[1];                    
                    const event = a.category === 14 ? `התרעה מקדימה` : a.title;
                    const location = a.data;
                    if (!r.curEvents.has(event)) {
                        r.curEvents.set(event, new Set());
                    }
                    r.curEvents.get(event).add(location);
                }
            }
            if (r.curEvents.size === 0) {
                continue;
            }
            const msgs = [];
            for (let event of r.curEvents.keys()) {
                let locations = [...r.curEvents.get(event)];
                locations.sort((a, b) => a.localeCompare(b, 'he'));
                let msg = `${event} - ${locations.join(`, `)}`;
                msgs.push(msg);    
            }
            await postToTelegram(bot, r.telegramChatId, msgs);
        }
    }
    
    setTimeout(() => {
        checkAlerts();
    }, checkAlertsIntervalMs);
}

console.log(`Server initializing...`);
const {envVarCheckAlertsIntervalMs, envVarBotToken} = loadEnvVars();
notifyReqs = readDataObjectFromFile('.', NOTIFY_REQS_FILE_NAME, []) || [];
checkAlertsIntervalMs = parseInt(envVarCheckAlertsIntervalMs);
bot = initTelegramBot(envVarBotToken);
console.log(`Server running...`);
checkAlerts(false);
