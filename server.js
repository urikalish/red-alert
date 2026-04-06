import { resolve, dirname } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { Telegraf } from 'telegraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ALERT_KEYS_FILE_NAME = 'alert-keys.json';

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
        locations: requireEnvVar('LOCATIONS'),
        botToken: requireEnvVar('BOT_TOKEN'),
        chatId: requireEnvVar('CHAT_ID'),
    }
}

function readDataObjectFromFile(dirPath, fileName) {
    let dataObject = null;
    const fullFilePath = `${dirPath}/${fileName}`;
    try {
        const outDir = resolve(__dirname, dirPath);
        const raw = readFileSync(resolve(outDir, fileName), 'utf8');
        dataObject = JSON.parse(raw);
    } catch (error) {
        console.warn(`Error while trying to read from ${fullFilePath}`, error);
    }
    return dataObject;
}

function writeDataObjectToFile(dataObject, dirPath, fileName) {
    const fullFilePath = `${dirPath}/${fileName}`;
    console.log(`Writing to ${fullFilePath}...`);
    try {
        const outDir = resolve(__dirname, dirPath);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(resolve(outDir, fileName), JSON.stringify(dataObject, null, 2));
        console.log(`File ${fullFilePath} updated.`);
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

async function checkAlerts(alertKeys, fetchTimeoutMs, locationsArr, bot, chatId) {
    const fetchedAlerts = await fetchAlertsHistory(fetchTimeoutMs);
    const relevantAlerts = fetchedAlerts.filter(alert => locationsArr.includes(alert.data));
    const newRelevantAlerts = [];
    relevantAlerts.forEach(alert => {
        const alertKey = getAlertKey(alert);
        if (!alertKeys.has(alertKey)) {
            alertKeys.add(alertKey);
            newRelevantAlerts.push(alert);    
        }
    });
    if (newRelevantAlerts.length === 0) {
        return;
    }
    newRelevantAlerts.sort((a, b) => new Date(a.alertDate) - new Date(b.alertDate));
    newRelevantAlerts.forEach(alert => {
        console.log(alert);
    });
    const msgs = [];
    newRelevantAlerts.forEach(alert => {
        const time = alert.alertDate.split(' ')[1];
        const location = alert.data;
        const event = alert.category === 14 ? `התרעה מקדימה` : alert.title;
        msgs.push(`${time}\n${location}\n${event}`);
    });
    await postToTelegram(bot, chatId, msgs);
    writeDataObjectToFile([...alertKeys], '.', ALERT_KEYS_FILE_NAME);
}

console.log(`Server running...`);
const {checkAlertsIntervalMs, locations, botToken, chatId} = loadEnvVars();
const fetchTimeoutMs = checkAlertsIntervalMs - 1000;
const locationsArr = locations.trim().split(',').map(i => i.trim());
const alertsKeysArray = readDataObjectFromFile('.', ALERT_KEYS_FILE_NAME) || [];
const alertKeys = new Set(alertsKeysArray);
const bot = initTelegramBot(botToken);
checkAlerts(alertKeys, fetchTimeoutMs, locationsArr, bot, chatId);
setInterval(() => {
    checkAlerts(alertKeys, fetchTimeoutMs, locationsArr, bot, chatId);
}, checkAlertsIntervalMs);
