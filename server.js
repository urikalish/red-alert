import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { Telegraf } from 'telegraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ALERT_KEYS_FILE_NAME = 'alert-keys.json';
const NOTIFY_REQS_FILE_NAME = 'notify-reqs.json';

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
        checkAlertsIntervalMs: requireEnvVar('CHECK_ALERTS_INTERVAL_MS'),
        botToken: requireEnvVar('BOT_TOKEN'),
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

async function fetchWithTimeout(url, fetchTimeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function fetchAlertsHistory(fetchTimeoutMs) {
    let alerts = [];
    const url = `https://www.oref.org.il/warningMessages/alert/History/AlertsHistory.json`;
    try {
        const response = await fetchWithTimeout(url, fetchTimeoutMs);
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
        console.log(`Posting to Telegram...`);
        await bot.telegram.sendMessage(chatId, msgs.join('\n')).catch(console.error);
        console.log(`Posted to Telegram.`);
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

async function checkAlerts({ alertKeys, bot, fetchTimeoutMs, notifyReqsArr }) {
    const {threeLetterDay, twoDigitHour} = getIsrDayAndHour();
    for (let req of notifyReqsArr) {
        req.nowNotifications = req.notifications.filter(n => n.days.includes(threeLetterDay) && n.hours.includes(twoDigitHour));
        req.msgs = [];
    }
    let newAlerts = false;
    const fetchedAlerts = await fetchAlertsHistory(fetchTimeoutMs);
    for (let a of fetchedAlerts) {
        const alertKey = getAlertKey(a);
        if (alertKeys.has(alertKey)) {
            continue;
        }
        newAlerts = true;
        alertKeys.add(alertKey);
        for (let req of notifyReqsArr) {
            for (let n of req.nowNotifications) {
                const location = a.data;
                if (n.locations.includes(location)) {
                    //const time = a.alertDate.split(' ')[1];                    
                    //req.msgs.push(`${time}\n${location}\n${event}`);
                    const event = a.category === 14 ? `התרעה מקדימה` : a.title;
                    req.msgs.push(`${location}\n${event}`);
                    break;
                }
            }
        }
    }    
    if (newAlerts) {
        for (let req of notifyReqsArr.filter(r => r.msgs.length > 0)) {
            await postToTelegram(bot, req.chatId, req.msgs);
        }
        writeDataObjectToFile([...alertKeys], '.', ALERT_KEYS_FILE_NAME);
    }
}

console.log(`Server initializing...`);
const {checkAlertsIntervalMs, botToken} = loadEnvVars();
const fetchTimeoutMs = checkAlertsIntervalMs - 1000;
const notifyReqsArr = readDataObjectFromFile('.', NOTIFY_REQS_FILE_NAME, []) || [];
const alertsKeysArray = readDataObjectFromFile('.', ALERT_KEYS_FILE_NAME, []) || [];
const alertKeys = new Set(alertsKeysArray);
const bot = initTelegramBot(botToken);
console.log(`Server running...`);

//postToTelegram(bot, chatId, [`TEST`]);

checkAlerts({ alertKeys, bot, fetchTimeoutMs, notifyReqsArr });
setInterval(() => {
    checkAlerts({ alertKeys, bot, fetchTimeoutMs, notifyReqsArr });
}, checkAlertsIntervalMs);
