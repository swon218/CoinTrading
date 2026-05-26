const https = require('https');

const BINANCE_FUTURES_REST_HOST = 'fapi.binance.com';
const BINANCE_FUTURES_REST_BASE = `https://${BINANCE_FUTURES_REST_HOST}`;
const EXCHANGE_INFO_TTL_MS = 60 * 60 * 1000;
const TICKER_TTL_MS = 1500;
const KLINE_LIMIT = 500;
const MAX_KLINE_LIMIT = 1500;

let exchangeInfoCache = null;
let tickerCache = new Map();

function requestJson(pathname, searchParams = {}) {
    const url = new URL(pathname, BINANCE_FUTURES_REST_BASE);
    Object.entries(searchParams).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    });

    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'CoinTrading/1.0',
            },
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                let payload = null;
                try {
                    payload = body ? JSON.parse(body) : null;
                } catch (error) {
                    reject(new Error(`Binance returned invalid JSON: ${error.message}`));
                    return;
                }

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    const message = payload?.msg || payload?.message || `Binance HTTP ${response.statusCode}`;
                    const error = new Error(message);
                    error.statusCode = response.statusCode;
                    error.payload = payload;
                    reject(error);
                    return;
                }

                resolve(payload);
            });
        });

        request.setTimeout(12000, () => {
            request.destroy(new Error('Binance request timed out.'));
        });
        request.on('error', reject);
    });
}

function normalizeSymbol(symbol) {
    return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function mapInterval(interval) {
    const normalized = String(interval || '').trim();
    const intervalMap = {
        1: '1m',
        3: '3m',
        5: '5m',
        15: '15m',
        30: '30m',
        60: '1h',
        120: '2h',
        day: '1d',
        week: '1w',
        month: '1M',
    };

    const allowed = new Set([
        '1m', '3m', '5m', '15m', '30m',
        '1h', '2h', '4h', '6h', '8h', '12h',
        '1d', '3d', '1w', '1M',
    ]);

    return intervalMap[normalized] || (allowed.has(normalized) ? normalized : '15m');
}

async function getExchangeInfo() {
    const now = Date.now();
    if (exchangeInfoCache && exchangeInfoCache.expiresAt > now) {
        return exchangeInfoCache.data;
    }

    const data = await requestJson('/fapi/v1/exchangeInfo');
    exchangeInfoCache = {
        data,
        expiresAt: now + EXCHANGE_INFO_TTL_MS,
    };
    return data;
}

async function searchFuturesSymbols(query, limit = 12) {
    const keyword = normalizeSymbol(query);
    if (!keyword) return [];

    const exchangeInfo = await getExchangeInfo();
    const maxItems = Math.max(1, Math.min(Number(limit) || 12, 30));

    return (exchangeInfo.symbols || [])
        .filter((item) => {
            return item.status === 'TRADING'
                && item.contractType === 'PERPETUAL'
                && item.quoteAsset === 'USDT'
                && item.symbol.includes(keyword);
        })
        .slice(0, maxItems)
        .map((item) => ({
            code: item.symbol,
            name: `${item.baseAsset}/USDT Perpetual`,
            baseAsset: item.baseAsset,
            quoteAsset: item.quoteAsset,
        }));
}

async function getTicker(symbol) {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (!normalizedSymbol) {
        const error = new Error('Symbol is required.');
        error.statusCode = 400;
        throw error;
    }

    const now = Date.now();
    const cached = tickerCache.get(normalizedSymbol);
    if (cached && cached.expiresAt > now) return cached.data;

    const payload = await requestJson('/fapi/v1/ticker/24hr', { symbol: normalizedSymbol });
    const lastPrice = Number(payload.lastPrice);
    const openPrice = Number(payload.openPrice);
    const change = Number(payload.priceChange);
    const changeRate = Number(payload.priceChangePercent);
    const data = {
        code: payload.symbol,
        name: `${payload.symbol.replace(/USDT$/, '')}/USDT Perpetual`,
        price: Number.isFinite(lastPrice) ? lastPrice : null,
        change: Number.isFinite(change) ? change : null,
        changeRate: Number.isFinite(changeRate) ? changeRate : null,
        direction: lastPrice > openPrice ? 'up' : lastPrice < openPrice ? 'down' : 'flat',
        high: Number(payload.highPrice),
        low: Number(payload.lowPrice),
        volume: Number(payload.volume),
        quoteVolume: Number(payload.quoteVolume),
    };

    tickerCache.set(normalizedSymbol, {
        data,
        expiresAt: now + TICKER_TTL_MS,
    });

    return data;
}

function normalizeKlineLimit(limit) {
    const count = Number(limit);
    if (!Number.isFinite(count) || count <= 0) return KLINE_LIMIT;
    return Math.max(1, Math.min(Math.floor(count), MAX_KLINE_LIMIT));
}

async function getKlines(symbol, interval = '15m', options = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (!normalizedSymbol) {
        const error = new Error('Symbol is required.');
        error.statusCode = 400;
        throw error;
    }

    const payload = await requestJson('/fapi/v1/klines', {
        symbol: normalizedSymbol,
        interval: mapInterval(interval),
        limit: normalizeKlineLimit(options.limit),
        startTime: options.startTime,
        endTime: options.endTime,
    });

    return {
        code: normalizedSymbol,
        interval: mapInterval(interval),
        candles: payload.map((item) => ({
            time: new Date(item[0]).toISOString(),
            open: Number(item[1]),
            high: Number(item[2]),
            low: Number(item[3]),
            close: Number(item[4]),
            volume: Number(item[5]),
            closeTime: new Date(item[6]).toISOString(),
        })),
    };
}

async function subscribeTickerPolling(request, response, symbol) {
    const normalizedSymbol = normalizeSymbol(symbol);
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
    });
    response.write(': connected\n\n');

    let closed = false;
    request.on('close', () => {
        closed = true;
        clearInterval(timer);
    });

    const sendTick = async () => {
        if (closed) return;
        try {
            const ticker = await getTicker(normalizedSymbol);
            response.write(`event: tick\n`);
            response.write(`data: ${JSON.stringify({
                code: ticker.code,
                price: ticker.price,
                change: ticker.change,
                changeRate: ticker.changeRate,
                direction: ticker.direction,
                high: ticker.high,
                low: ticker.low,
                volume: ticker.volume,
                time: new Date().toISOString(),
            })}\n\n`);
        } catch (error) {
            response.write(`event: error\n`);
            response.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
        }
    };

    const timer = setInterval(sendTick, 2500);
    await sendTick();
}

module.exports = {
    getKlines,
    getTicker,
    mapInterval,
    searchFuturesSymbols,
    subscribeTickerPolling,
};
