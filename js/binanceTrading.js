import { drawStockChart } from './chartRenderer.js';
import {
    getIndicatorDefinition,
    indicatorDefinitions,
    normalizeIndicatorValues,
} from './indicators/registry.js';

document.addEventListener('DOMContentLoaded', () => {
    const sidebarToggle = document.getElementById('sidebarToggle');
    const appSidebar = document.getElementById('appSidebar');
    const compactLayoutQuery = window.matchMedia('(max-width: 1100px)');
    const searchBar = document.getElementById('searchBar');
    const searchClearButton = document.getElementById('searchClearButton');
    const searchModal = document.getElementById('searchModal');
    const searchResults = document.getElementById('searchResults');
    const chartCanvas = document.getElementById('stockChart');
    const chartArea = document.querySelector('.chart_area');
    const chartStatus = document.getElementById('chartStatus');
    const chartIntervalButtons = Array.from(document.querySelectorAll('.chart-interval-btn'));
    const chartZoomIn = document.getElementById('chartZoomIn');
    const chartZoomOut = document.getElementById('chartZoomOut');
    const serverConnectionStatus = document.getElementById('serverConnectionStatus');
    const serverConnectionText = document.getElementById('serverConnectionText');
    const rightPanelTabs = document.querySelectorAll('[data-panel-tab]');
    const indicatorPanel = document.getElementById('indicatorPanel');
    const orderPanel = document.getElementById('orderPanel');
    const indicatorSearchInput = document.getElementById('indicatorSearchInput');
    const indicatorSearchDropdown = document.getElementById('indicatorSearchDropdown');
    const indicatorAddButton = document.getElementById('indicatorAddButton');
    const indicatorCards = document.getElementById('indicatorCards');
    const indicatorResetButton = document.getElementById('indicatorResetButton');
    const orderForm = document.getElementById('orderForm');
    const orderPriceInput = document.getElementById('orderPriceInput');
    const orderQuantityInput = document.getElementById('orderQuantityInput');
    const orderTotalInput = document.getElementById('orderTotalInput');
    const orderAvailableAmount = document.getElementById('orderAvailableAmount');
    const orderSubmitButton = document.getElementById('orderSubmitButton');
    const orderMessage = document.getElementById('orderMessage');

    const quoteEls = {
        name: document.getElementById('stockName'),
        code: document.getElementById('stockCode'),
        price: document.getElementById('stockPrice'),
        change: document.getElementById('stockChange'),
        high: document.getElementById('stockHigh'),
        low: document.getElementById('stockLow'),
        volume: document.getElementById('stockVolume'),
    };

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

    let currentSymbol = '';
    let currentInterval = '15';
    let latestCandles = [];
    let latestTicker = null;
    let latestResults = [];
    let activeSearchIndex = -1;
    let searchTimer = null;
    let realtimeSource = null;
    let visibleCandleCount = 90;
    let chartStartIndex = 0;
    let chartHoverPoint = null;
    let chartRedrawFrame = null;
    let isChartDragging = false;
    let chartDragStartX = 0;
    let chartDragStartIndex = 0;
    let priceScaleZoom = 1;
    let lowerIndicatorScrollOffset = 0;
    let activeIndicators = [];

    const formatNumber = (value, options = {}) => {
        const number = Number(value);
        if (!Number.isFinite(number)) return '-';
        return number.toLocaleString('ko-KR', {
            maximumFractionDigits: options.maximumFractionDigits ?? (Math.abs(number) < 1 ? 6 : 2),
        });
    };

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const setStatus = (message = '') => {
        if (!chartStatus) return;
        chartStatus.textContent = message;
        chartStatus.classList.toggle('hidden', !message);
    };

    const setConnectionStatus = (connected, text) => {
        serverConnectionStatus?.classList.toggle('is-disconnected', !connected);
        serverConnectionStatus?.classList.toggle('is-connected', connected);
        if (serverConnectionText) serverConnectionText.textContent = text;
    };

    const setDirectionClass = (element, direction) => {
        if (!element) return;
        element.classList.remove('text-red-500', 'text-blue-500', 'text-slate-300');
        if (direction === 'up') element.classList.add('text-red-500');
        else if (direction === 'down') element.classList.add('text-blue-500');
        else element.classList.add('text-slate-300');
    };

    const resizeChartCanvas = () => {
        if (!chartCanvas) return null;
        const rect = chartCanvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(320, Math.floor(rect.width));
        const height = Math.max(260, Math.floor(rect.height));
        chartCanvas.width = Math.floor(width * dpr);
        chartCanvas.height = Math.floor(height * dpr);
        chartCanvas.style.width = `${width}px`;
        chartCanvas.style.height = `${height}px`;
        const ctx = chartCanvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx, width, height };
    };

    const clampChartWindow = () => {
        const maxStart = Math.max(0, latestCandles.length - visibleCandleCount);
        chartStartIndex = Math.max(0, Math.min(chartStartIndex, maxStart));
    };

    const snapChartToLatest = () => {
        chartStartIndex = Math.max(0, latestCandles.length - visibleCandleCount);
    };

    const getVisibleCandles = () => {
        clampChartWindow();
        return latestCandles.slice(chartStartIndex, chartStartIndex + visibleCandleCount);
    };

    const formatChartTime = (time, interval = currentInterval, compact = false) => {
        const date = new Date(time);
        if (Number.isNaN(date.getTime())) return '';
        const options = intervalMap[interval]?.includes('d') || ['day', 'week', 'month'].includes(interval)
            ? { month: '2-digit', day: '2-digit' }
            : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
        if (!compact) options.year = '2-digit';
        return new Intl.DateTimeFormat('ko-KR', options).format(date);
    };

    const redrawChart = () => {
        drawStockChart({
            chartCanvas,
            resizeChartCanvas,
            candles: getVisibleCandles(),
            activeIndicators,
            indicatorScrollOffset: lowerIndicatorScrollOffset,
            chartHoverPoint,
            currentChartInterval: currentInterval,
            priceScaleZoom,
            formatChartTime,
            setChartStatus: setStatus,
        });
    };

    const requestChartRedraw = () => {
        if (chartRedrawFrame) return;
        chartRedrawFrame = requestAnimationFrame(() => {
            chartRedrawFrame = null;
            redrawChart();
        });
    };

    const updateUrl = () => {
        if (!currentSymbol) return;
        const url = new URL(window.location.href);
        url.searchParams.set('symbol', currentSymbol);
        url.searchParams.set('interval', currentInterval);
        window.history.replaceState(null, '', url);
    };

    const updateTickerView = (ticker) => {
        latestTicker = ticker;
        const symbol = ticker.code || currentSymbol;
        const base = symbol.replace(/USDT$/, '');
        if (quoteEls.name) quoteEls.name.textContent = ticker.name || `${base}/USDT Perpetual`;
        if (quoteEls.code) quoteEls.code.textContent = symbol || '-';
        if (quoteEls.price) quoteEls.price.textContent = formatNumber(ticker.price);
        if (quoteEls.high) quoteEls.high.textContent = formatNumber(ticker.high);
        if (quoteEls.low) quoteEls.low.textContent = formatNumber(ticker.low);
        if (quoteEls.volume) quoteEls.volume.textContent = formatNumber(ticker.volume, { maximumFractionDigits: 3 });
        if (quoteEls.change) {
            const sign = ticker.direction === 'up' ? '▲' : ticker.direction === 'down' ? '▼' : '-';
            quoteEls.change.textContent = `${sign} ${formatNumber(Math.abs(ticker.change || 0))} (${Number(ticker.changeRate || 0).toFixed(2)}%)`;
        }
        setDirectionClass(quoteEls.price, ticker.direction);
        setDirectionClass(quoteEls.change, ticker.direction);
        updateOrderTotal();
    };

    const resetTickerView = () => {
        Object.values(quoteEls).forEach((element) => {
            if (element) element.textContent = '-';
        });
        latestTicker = null;
        setConnectionStatus(false, 'Binance 대기');
    };

    const fetchJson = async (url) => {
        const response = await fetch(url, { cache: 'no-store' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
        return payload;
    };

    const fetchTicker = async (symbol) => {
        const ticker = await fetchJson(`/api/binance/ticker/${encodeURIComponent(symbol)}`);
        updateTickerView(ticker);
        return ticker;
    };

    const fetchChart = async (symbol = currentSymbol, interval = currentInterval) => {
        if (!symbol) {
            latestCandles = [];
            setStatus('코인을 검색하면 Binance 선물 차트가 표시됩니다.');
            requestChartRedraw();
            return;
        }

        setStatus('Binance 선물 캔들을 불러오는 중...');
        const params = new URLSearchParams({
            interval: intervalMap[interval] || interval,
            limit: '500',
        });
        const chart = await fetchJson(`/api/binance/chart/${encodeURIComponent(symbol)}?${params.toString()}`);
        latestCandles = (chart.candles || []).filter((candle) => {
            return Number.isFinite(candle.open) && Number.isFinite(candle.high)
                && Number.isFinite(candle.low) && Number.isFinite(candle.close);
        });
        snapChartToLatest();
        setStatus(latestCandles.length ? '' : '차트 데이터가 없습니다.');
        requestChartRedraw();
    };

    const startRealtime = (symbol) => {
        if (realtimeSource) {
            realtimeSource.close();
            realtimeSource = null;
        }
        realtimeSource = new EventSource(`/api/binance/realtime/${encodeURIComponent(symbol)}`);
        realtimeSource.addEventListener('tick', (event) => {
            const tick = JSON.parse(event.data);
            updateTickerView(tick);
            applyTickToLatestCandle(tick);
            setConnectionStatus(true, 'Binance 연결');
        });
        realtimeSource.addEventListener('error', () => {
            setConnectionStatus(false, 'Binance 재연결 중');
        });
    };

    const bucketTime = (time, interval) => {
        const date = new Date(time);
        if (Number.isNaN(date.getTime())) return new Date().toISOString();
        const mapped = intervalMap[interval] || interval;
        const minuteMap = {
            '1m': 1,
            '3m': 3,
            '5m': 5,
            '15m': 15,
            '30m': 30,
            '1h': 60,
            '2h': 120,
            '4h': 240,
            '6h': 360,
            '8h': 480,
            '12h': 720,
        };
        const minutes = minuteMap[mapped];
        if (!minutes) {
            date.setUTCHours(0, 0, 0, 0);
            return date.toISOString();
        }
        const totalMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
        const bucketMinutes = Math.floor(totalMinutes / minutes) * minutes;
        date.setUTCHours(Math.floor(bucketMinutes / 60), bucketMinutes % 60, 0, 0);
        return date.toISOString();
    };

    const applyTickToLatestCandle = (tick) => {
        const price = Number(tick.price);
        if (!latestCandles.length || !Number.isFinite(price)) return;
        const keepLatest = chartStartIndex + visibleCandleCount >= latestCandles.length;
        const nextTime = bucketTime(tick.time, currentInterval);
        const last = latestCandles[latestCandles.length - 1];

        if (last.time === nextTime) {
            last.high = Math.max(last.high, price);
            last.low = Math.min(last.low, price);
            last.close = price;
        } else {
            latestCandles.push({
                time: nextTime,
                open: last.close,
                high: Math.max(last.close, price),
                low: Math.min(last.close, price),
                close: price,
                volume: 0,
            });
            latestCandles = latestCandles.slice(-500);
        }

        if (keepLatest) snapChartToLatest();
        requestChartRedraw();
    };

    const selectSymbol = async (symbol) => {
        currentSymbol = String(symbol || '').trim().toUpperCase();
        if (!currentSymbol) return;
        setConnectionStatus(false, 'Binance 조회 중');
        searchModal?.classList.remove('show');
        if (searchBar) searchBar.value = '';
        updateSearchClearButton();
        renderSearchMessage('코인명 또는 심볼을 입력하세요.');
        updateUrl();
        try {
            await Promise.all([
                fetchTicker(currentSymbol),
                fetchChart(currentSymbol, currentInterval),
            ]);
            startRealtime(currentSymbol);
        } catch (error) {
            console.error('Binance symbol request failed.', error);
            setStatus(error.message || 'Binance 데이터를 불러오지 못했습니다.');
            setConnectionStatus(false, 'Binance 오류');
        }
    };

    const renderSearchMessage = (message) => {
        if (!searchResults) return;
        latestResults = [];
        searchResults.innerHTML = `<div class="search-empty">${escapeHtml(message)}</div>`;
    };

    const renderSearchResults = (results = []) => {
        latestResults = results;
        activeSearchIndex = -1;
        if (!searchResults) return;
        if (!results.length) {
            renderSearchMessage('검색 결과가 없습니다.');
            return;
        }
        searchResults.innerHTML = results.map((item, index) => `
            <button type="button" class="search-result-item" data-code="${escapeHtml(item.code)}" data-index="${index}">
                <span class="search-result-name">${escapeHtml(item.name || item.code)}</span>
                <span class="search-result-code">${escapeHtml(item.code)}</span>
            </button>
        `).join('');
    };

    const searchSymbols = async (query) => {
        const keyword = String(query || '').trim();
        if (!keyword) {
            renderSearchMessage('코인명 또는 심볼을 입력하세요.');
            return;
        }
        try {
            renderSearchMessage('Binance 선물 심볼 검색 중...');
            const payload = await fetchJson(`/api/binance/search?q=${encodeURIComponent(keyword)}&limit=12`);
            renderSearchResults(payload.results || []);
        } catch (error) {
            console.error('Binance search failed.', error);
            renderSearchMessage('검색 중 오류가 발생했습니다.');
        }
    };

    const updateSearchClearButton = () => {
        searchClearButton?.classList.toggle('visible', Boolean(searchBar?.value));
    };

    const setActiveIntervalButton = () => {
        chartIntervalButtons.forEach((button) => {
            const active = button.dataset.interval === currentInterval;
            button.classList.toggle('text-emerald-400', active);
            button.classList.toggle('font-medium', active);
            button.classList.toggle('border-b-2', active);
            button.classList.toggle('border-emerald-400', active);
            button.classList.toggle('text-slate-400', !active);
        });
    };

    const setRightPanel = (panelName = 'order') => {
        const isOrder = panelName === 'order';
        orderPanel?.classList.toggle('hidden', !isOrder);
        indicatorPanel?.classList.toggle('hidden', isOrder);
        rightPanelTabs.forEach((button) => {
            const active = button.dataset.panelTab === panelName;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
        });
    };

    const cloneIndicator = (definition) => ({
        id: `${definition.key}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        key: definition.key,
        values: Object.fromEntries(definition.fields.map((field) => [field.key, field.value])),
    });

    const renderIndicatorCards = () => {
        if (!indicatorCards) return;
        if (!activeIndicators.length) {
            indicatorCards.innerHTML = '<div class="indicator-empty">지표를 추가하면 차트에 표시됩니다.</div>';
            requestChartRedraw();
            return;
        }
        indicatorCards.innerHTML = activeIndicators.map((indicator) => {
            const definition = getIndicatorDefinition(indicator.key);
            if (!definition) return '';
            const fields = definition.fields.map((field) => `
                <label class="indicator-field">
                    <span>${escapeHtml(field.label)}</span>
                    <input type="${field.type === 'color' ? 'color' : 'number'}" data-indicator-id="${indicator.id}" data-field-key="${field.key}" value="${escapeHtml(indicator.values[field.key])}">
                </label>
            `).join('');
            return `
                <div class="indicator-card">
                    <div class="indicator-card-header">
                        <strong>${escapeHtml(definition.name)}</strong>
                        <button type="button" data-remove-indicator="${indicator.id}" aria-label="지표 삭제">×</button>
                    </div>
                    ${fields}
                </div>
            `;
        }).join('');
        requestChartRedraw();
    };

    const renderIndicatorDropdown = (query = '') => {
        if (!indicatorSearchDropdown) return;
        const keyword = String(query || '').trim().toLowerCase();
        const items = indicatorDefinitions
            .filter((definition) => {
                return !keyword
                    || definition.name.toLowerCase().includes(keyword)
                    || definition.key.toLowerCase().includes(keyword);
            })
            .slice(0, 10);

        indicatorSearchDropdown.innerHTML = items.map((definition) => `
            <button type="button" data-indicator-key="${definition.key}">
                ${escapeHtml(definition.name)}
            </button>
        `).join('');
        indicatorSearchDropdown.classList.toggle('hidden', !items.length);
    };

    const addIndicator = (key) => {
        const definition = getIndicatorDefinition(key);
        if (!definition || activeIndicators.some((indicator) => indicator.key === key)) return;
        activeIndicators.push(cloneIndicator(definition));
        renderIndicatorCards();
    };

    const updateOrderTotal = () => {
        const price = Number(String(orderPriceInput?.value || '').replace(/,/g, '')) || latestTicker?.price || 0;
        const quantity = Number(String(orderQuantityInput?.value || '').replace(/,/g, '')) || 0;
        if (orderTotalInput) {
            orderTotalInput.value = price && quantity ? `${formatNumber(price * quantity)} USDT` : '';
        }
        if (orderAvailableAmount) {
            orderAvailableAmount.value = 'Binance 계정 연동 후 조회';
        }
    };

    const zoomChart = (direction) => {
        const factor = direction === 'in' ? 0.82 : 1.22;
        visibleCandleCount = Math.max(25, Math.min(250, Math.round(visibleCandleCount * factor)));
        snapChartToLatest();
        requestChartRedraw();
    };

    searchBar?.addEventListener('focus', () => {
        searchModal?.classList.add('show');
        if (searchBar.value.trim()) searchSymbols(searchBar.value);
        else renderSearchMessage('코인명 또는 심볼을 입력하세요.');
    });

    searchBar?.addEventListener('input', () => {
        searchModal?.classList.add('show');
        updateSearchClearButton();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => searchSymbols(searchBar.value), 250);
    });

    searchBar?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const selected = activeSearchIndex >= 0 ? latestResults[activeSearchIndex] : latestResults[0];
        const target = selected?.code || searchBar.value.trim();
        if (target) selectSymbol(target);
    });

    searchClearButton?.addEventListener('click', () => {
        if (searchBar) searchBar.value = '';
        updateSearchClearButton();
        renderSearchMessage('코인명 또는 심볼을 입력하세요.');
        searchBar?.focus();
    });

    searchResults?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-code]');
        if (!button) return;
        selectSymbol(button.dataset.code);
    });

    document.addEventListener('click', (event) => {
        if (searchModal && !searchModal.contains(event.target) && event.target !== searchBar) {
            searchModal.classList.remove('show');
        }
    });

    chartIntervalButtons.forEach((button) => {
        button.addEventListener('click', () => {
            currentInterval = button.dataset.interval || '15';
            setActiveIntervalButton();
            updateUrl();
            fetchChart(currentSymbol, currentInterval).catch((error) => {
                setStatus(error.message || '차트 조회에 실패했습니다.');
            });
        });
    });

    chartCanvas?.addEventListener('wheel', (event) => {
        event.preventDefault();
        zoomChart(event.deltaY < 0 ? 'in' : 'out');
    }, { passive: false });

    chartCanvas?.addEventListener('mousemove', (event) => {
        const rect = chartCanvas.getBoundingClientRect();
        chartHoverPoint = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        };
        requestChartRedraw();
        if (!isChartDragging) chartCanvas.style.cursor = latestCandles.length ? 'grab' : '';
    });

    chartCanvas?.addEventListener('mouseleave', () => {
        chartHoverPoint = null;
        requestChartRedraw();
    });

    chartCanvas?.addEventListener('mousedown', (event) => {
        if (event.button !== 0 || !latestCandles.length) return;
        isChartDragging = true;
        chartDragStartX = event.clientX;
        chartDragStartIndex = chartStartIndex;
        chartCanvas.classList.add('dragging');
    });

    window.addEventListener('mousemove', (event) => {
        if (!isChartDragging || !chartCanvas) return;
        const rect = chartCanvas.getBoundingClientRect();
        const candleWidth = Math.max(1, rect.width / Math.max(1, visibleCandleCount));
        const movedCandles = Math.round((event.clientX - chartDragStartX) / candleWidth);
        chartStartIndex = chartDragStartIndex - movedCandles;
        clampChartWindow();
        requestChartRedraw();
    });

    window.addEventListener('mouseup', () => {
        if (!isChartDragging) return;
        isChartDragging = false;
        chartCanvas?.classList.remove('dragging');
    });

    chartZoomIn?.addEventListener('click', () => zoomChart('in'));
    chartZoomOut?.addEventListener('click', () => zoomChart('out'));

    rightPanelTabs.forEach((button) => {
        button.addEventListener('click', () => setRightPanel(button.dataset.panelTab));
    });

    indicatorSearchInput?.addEventListener('focus', () => renderIndicatorDropdown(indicatorSearchInput.value));
    indicatorSearchInput?.addEventListener('input', () => renderIndicatorDropdown(indicatorSearchInput.value));
    indicatorSearchDropdown?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-indicator-key]');
        if (!button) return;
        addIndicator(button.dataset.indicatorKey);
        indicatorSearchDropdown.classList.add('hidden');
        if (indicatorSearchInput) indicatorSearchInput.value = '';
    });
    indicatorAddButton?.addEventListener('click', () => {
        const keyword = indicatorSearchInput?.value.trim().toLowerCase();
        const definition = indicatorDefinitions.find((item) => {
            return item.key.toLowerCase() === keyword || item.name.toLowerCase().includes(keyword);
        }) || indicatorDefinitions[0];
        if (definition) addIndicator(definition.key);
    });
    indicatorCards?.addEventListener('input', (event) => {
        const input = event.target.closest('[data-indicator-id][data-field-key]');
        if (!input) return;
        const indicator = activeIndicators.find((item) => item.id === input.dataset.indicatorId);
        if (!indicator) return;
        indicator.values[input.dataset.fieldKey] = Number(input.value);
        indicator.values = normalizeIndicatorValues(indicator.key, indicator.values);
        requestChartRedraw();
    });
    indicatorCards?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-remove-indicator]');
        if (!button) return;
        activeIndicators = activeIndicators.filter((indicator) => indicator.id !== button.dataset.removeIndicator);
        renderIndicatorCards();
    });
    indicatorResetButton?.addEventListener('click', () => {
        activeIndicators = [];
        renderIndicatorCards();
    });

    [orderPriceInput, orderQuantityInput].forEach((input) => {
        input?.addEventListener('input', updateOrderTotal);
    });

    orderForm?.addEventListener('submit', (event) => {
        event.preventDefault();
        if (orderMessage) {
            orderMessage.textContent = '실주문은 Binance 서명 주문 API 연결 후 활성화됩니다.';
            orderMessage.classList.add('is-error');
        }
    });

    if (orderSubmitButton) {
        orderSubmitButton.textContent = 'Binance 주문 준비 중';
    }

    sidebarToggle?.addEventListener('click', () => {
        if (!appSidebar) return;
        if (compactLayoutQuery.matches) {
            document.body.classList.toggle('compact-sidebar-open');
            appSidebar.classList.toggle('is-collapsed', !document.body.classList.contains('compact-sidebar-open'));
        } else {
            appSidebar.classList.toggle('is-collapsed');
        }
        window.setTimeout(requestChartRedraw, 260);
    });

    if (window.ResizeObserver && chartArea) {
        new ResizeObserver(requestChartRedraw).observe(chartArea);
    }
    window.addEventListener('resize', requestChartRedraw);

    resetTickerView();
    renderIndicatorCards();
    setRightPanel('order');
    setActiveIntervalButton();
    setStatus('코인을 검색하면 Binance 선물 차트가 표시됩니다.');
    requestChartRedraw();

    const urlParams = new URLSearchParams(window.location.search);
    const initialSymbol = urlParams.get('symbol') || urlParams.get('code') || 'BTCUSDT';
    const initialInterval = urlParams.get('interval');
    if (initialInterval && (intervalMap[initialInterval] || Object.values(intervalMap).includes(initialInterval))) {
        currentInterval = initialInterval;
        setActiveIntervalButton();
    }
    selectSymbol(initialSymbol);
});
