import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { Telegraf } from 'telegraf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let allAlerts = [];
let allAlertsKeys = new Set();

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

function initBot(botToken) {
    console.log(`Bot initializing...`);
    const bot = new Telegraf(botToken);
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
    console.log(`Bot initialized.`);
    return bot;
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

async function reportToTelegram(bot, chatId, alerts) {
    try {
        const msgs = [];
        alerts.forEach(alert => {
            const time = alert.alertDate.split(' ')[1];
            msgs.push(`${time}\n${alert.data}\n${alert.title}`);
        });
        console.log(`Reporting to Telegram...`);
        await bot.telegram.sendMessage(chatId, msgs.join('\n')).catch(console.error);
        console.log(`Reported to Telegram.`);
    } catch (error) {
        console.error('Failed posting to Telegram!', error);
    }
}

async function checkAlerts(fetchTimeoutMs, locations, bot, chatId) {
    const fetchedAlerts = await fetchAlertsHistory(fetchTimeoutMs);
    const newAlerts = fetchedAlerts.filter(alert => !allAlertsKeys.has(getAlertKey(alert)));
    allAlerts = fetchedAlerts;
    allAlertsKeys = new Set(allAlerts.map(getAlertKey));
    if (newAlerts.length === 0) {
        return;
    }
    console.log(`${newAlerts.length} new alerts.`);
    const locationsArr = locations.trim().split(',').map(i => i.trim());
    const locationAlerts = [];
    newAlerts.forEach(alert => {
        if (locationsArr.includes(alert.data)) {
            locationAlerts.push(alert);
        }
    });
    if (locationAlerts.length === 0) {
        return;
    }
    locationAlerts.sort((a, b) => new Date(a.alertDate) - new Date(b.alertDate));
    locationAlerts.forEach(alert => {
        console.log(alert);
    });
    reportToTelegram(bot, chatId, locationAlerts);    
}

console.log(`Server running...`);
const {checkAlertsIntervalMs, locations, botToken, chatId} = loadEnvVars();
const fetchTimeoutMs = checkAlertsIntervalMs - 1000;
const bot = initBot(botToken);
checkAlerts(fetchTimeoutMs, locations, bot, chatId);
setInterval(() => {
    checkAlerts(fetchTimeoutMs, locations, bot, chatId);
}, checkAlertsIntervalMs);
