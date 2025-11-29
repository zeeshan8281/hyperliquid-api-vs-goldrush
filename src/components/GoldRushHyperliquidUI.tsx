import React, { useEffect, useState } from 'react';
import { GoldRushClient } from '@covalenthq/client-sdk';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
} from 'recharts';
import { Activity, Zap, AlertTriangle, Terminal } from 'lucide-react';

// Types
interface Candle {
    ts: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface Trade {
    coin: string;
    side: string;
    px: string;
    sz: string;
    time: number;
    hash: string;
}

const GoldRushHyperliquidUI: React.FC = () => {
    // Config
    const HL_WS_URL = import.meta.env.VITE_HL_WS_URL || 'wss://api.hyperliquid.xyz/ws';

    const GR_API_KEY = import.meta.env.VITE_GR_API_KEY || '';
    const TOKEN_SYMBOL = import.meta.env.VITE_TOKEN_SYMBOL || 'HYPE';
    const TOKEN_ADDRESS = import.meta.env.VITE_TOKEN_ADDRESS || '0x0d01dc56dcaaca66ad901c959b4011ec';

    // State
    const [hlCandles, setHlCandles] = useState<Candle[]>([]);
    const [grCandles, setGrCandles] = useState<Candle[]>([]);
    const [hlTrades, setHlTrades] = useState<Trade[]>([]);
    const [logs, setLogs] = useState<string[]>([]);
    const [metrics, setMetrics] = useState({
        matchedPct: 0,
        meanPriceBps: 0,
        avgLatencyDiffMs: 0
    });

    const addLog = (msg: string) => {
        setLogs(prev => [msg, ...prev].slice(0, 50));
    };

    // Hyperliquid Connection
    useEffect(() => {
        const ws = new WebSocket(HL_WS_URL);

        ws.onopen = () => {
            addLog('Hyperliquid WS Connected');
            ws.send(JSON.stringify({
                method: 'subscribe',
                subscription: { type: 'trades', coin: TOKEN_SYMBOL }
            }));
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.channel === 'trades') {
                const newTrades = data.data as Trade[];
                setHlTrades(prev => [...prev, ...newTrades].slice(-500));

                // Aggregate candles (simplified 1m aggregation)
                newTrades.forEach(trade => {
                    const ts = Math.floor(trade.time / 60000) * 60000;
                    const price = parseFloat(trade.px);
                    const size = parseFloat(trade.sz);

                    setHlCandles(prev => {
                        const last = prev[prev.length - 1];
                        if (last && last.ts === ts) {
                            return [
                                ...prev.slice(0, -1),
                                {
                                    ...last,
                                    high: Math.max(last.high, price),
                                    low: Math.min(last.low, price),
                                    close: price,
                                    volume: last.volume + size
                                }
                            ];
                        } else {
                            return [
                                ...prev,
                                {
                                    ts,
                                    open: price,
                                    high: price,
                                    low: price,
                                    close: price,
                                    volume: size
                                }
                            ].slice(-100);
                        }
                    });
                });
            }
        };

        ws.onerror = (e) => addLog(`HL Error: ${e}`);

        return () => ws.close();
    }, [HL_WS_URL, TOKEN_SYMBOL]);

    // GoldRush Connection (SDK)
    useEffect(() => {
        if (!GR_API_KEY) {
            addLog('Missing GoldRush API Key');
            return;
        }

        const client = new GoldRushClient(
            GR_API_KEY,
            {},
            {
                onConnecting: () => addLog('GoldRush SDK Connecting...'),
                onOpened: () => addLog('GoldRush SDK Connected'),
                onClosed: () => addLog('GoldRush SDK Disconnected'),
                onError: (error) => addLog(`GoldRush SDK Error: ${error}`),
            }
        );

        const unsubscribe = client.StreamingService.rawQuery(
            `subscription {
                ohlcvCandlesForToken(
                    chain_name: HYPERCORE_MAINNET
                    token_addresses: ["HYPE"]
                    interval: ONE_MINUTE
                    timeframe: ONE_HOUR
                ) {
                    chain_name
                    interval
                    timeframe
                    timestamp
                    open
                    high
                    low
                    close
                    volume
                    volume_usd
                    quote_rate
                    quote_rate_usd
                    base_token {
                        contract_name
                        contract_address
                        contract_decimals
                        contract_ticker_symbol
                    }
                }
            }`,
            {},
            {
                next: (data: any) => {
                    console.log('GR Data:', data); // Debug log
                    // Check both data.data (standard GraphQL) and data (if unwrapped)
                    const candles = data?.data?.ohlcvCandlesForToken || data?.ohlcvCandlesForToken;

                    if (Array.isArray(candles) && candles.length > 0) {
                        setGrCandles(prev => {
                            let newCandles = [...prev];

                            candles.forEach((c: any) => {
                                const ts = new Date(c.timestamp).getTime();
                                const candle: Candle = {
                                    ts,
                                    open: c.open,
                                    high: c.high,
                                    low: c.low,
                                    close: c.close,
                                    volume: c.volume
                                };

                                const existsIndex = newCandles.findIndex(nc => nc.ts === ts);
                                if (existsIndex >= 0) {
                                    newCandles[existsIndex] = candle;
                                } else {
                                    newCandles.push(candle);
                                }
                            });

                            // Sort and slice
                            return newCandles.sort((a, b) => a.ts - b.ts).slice(-100);
                        });
                    } else {
                        addLog(`GR: Received empty or invalid data: ${JSON.stringify(data)}`);
                    }
                },
                error: (err) => {
                    console.error('GR Stream Error:', err);
                    addLog(`GR Stream Error: ${JSON.stringify(err)}`);
                },
                complete: () => addLog('GR Stream Complete'),
            }
        );

        addLog(`Subscribing to ${TOKEN_SYMBOL} on HYPERCORE_MAINNET`);

        return () => {
            unsubscribe();
            client.StreamingService.disconnect();
        };
    }, [GR_API_KEY, TOKEN_ADDRESS, TOKEN_SYMBOL]);

    // Metrics Calculation
    useEffect(() => {
        if (hlCandles.length === 0 || grCandles.length === 0) return;

        let matches = 0;
        let priceDiffSum = 0;
        let count = 0;

        hlCandles.forEach(hl => {
            const gr = grCandles.find(c => c.ts === hl.ts);
            if (gr) {
                matches++;
                const diff = Math.abs(hl.close - gr.close) / hl.close;
                priceDiffSum += diff;
                count++;
            }
        });

        setMetrics({
            matchedPct: count > 0 ? Math.round((matches / hlCandles.length) * 100) : 0,
            meanPriceBps: count > 0 ? (priceDiffSum / count) * 10000 : 0,
            avgLatencyDiffMs: 0
        });

    }, [hlCandles, grCandles]);

    const formatTime = (ts: number) => new Date(ts).toLocaleTimeString();

    return (
        <div className="p-6 bg-slate-100 min-h-screen font-sans text-slate-900">
            <header className="mb-6 flex justify-between items-center">
                <div>
                    <h1 className="text-2xl font-bold flex items-center gap-2">
                        <Activity className="text-blue-600" />
                        GoldRush vs Hyperliquid
                    </h1>
                    <p className="text-slate-500">Side-by-side OHLCV Comparison</p>
                </div>
                <div className="flex gap-4 text-sm">
                    <div className="bg-white px-3 py-1 rounded shadow-sm">
                        <span className="font-semibold">Token:</span> {TOKEN_SYMBOL}
                    </div>
                    <div className="bg-white px-3 py-1 rounded shadow-sm">
                        <span className="font-semibold">Address:</span> {TOKEN_ADDRESS.slice(0, 6)}...
                    </div>
                </div>
            </header>

            <main className="grid grid-cols-12 gap-6">
                {/* Left: Hyperliquid */}
                <section className="col-span-6 bg-white rounded-2xl shadow-lg p-4 border border-slate-200">
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="font-bold text-lg flex items-center gap-2">
                            <Zap className="text-yellow-500" size={20} />
                            Hyperliquid Direct
                        </h2>
                        <span className="text-xs bg-slate-100 px-2 py-1 rounded">Raw Trades Aggregated</span>
                    </div>

                    <div className="h-64 mb-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={hlCandles}>
                                <XAxis dataKey="ts" tickFormatter={formatTime} />
                                <YAxis domain={['auto', 'auto']} />
                                <Tooltip labelFormatter={formatTime} />
                                <Line type="monotone" dataKey="close" stroke="#eab308" dot={false} strokeWidth={2} />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>

                    <div className="bg-slate-900 text-slate-50 p-3 rounded-lg h-48 overflow-y-auto font-mono text-xs">
                        <div className="flex items-center gap-2 mb-2 text-slate-400 border-b border-slate-700 pb-1">
                            <Terminal size={14} /> Raw Trades Stream ({hlTrades.length})
                        </div>
                        {hlTrades.slice().reverse().map((t, i) => (
                            <div key={i} className="flex justify-between">
                                <span className={t.side === 'B' ? 'text-green-400' : 'text-red-400'}>
                                    {t.side} {parseFloat(t.sz).toFixed(2)} @ {parseFloat(t.px).toFixed(4)}
                                </span>
                                <span className="text-slate-500">{formatTime(t.time)}</span>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Right: GoldRush */}
                <section className="col-span-6 bg-white rounded-2xl shadow-lg p-4 border border-slate-200">
                    <div className="flex justify-between items-center mb-4">
                        <h2 className="font-bold text-lg flex items-center gap-2">
                            <Activity className="text-blue-600" size={20} />
                            GoldRush API
                        </h2>
                        <span className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded">GraphQL Subscription</span>
                    </div>

                    <div className="h-64 mb-4">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={grCandles}>
                                <XAxis dataKey="ts" tickFormatter={formatTime} />
                                <YAxis domain={['auto', 'auto']} />
                                <Tooltip labelFormatter={formatTime} />
                                <Line type="monotone" dataKey="close" stroke="#2563eb" dot={false} strokeWidth={2} />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>

                    <div className="bg-slate-50 p-3 rounded-lg h-48 overflow-y-auto text-xs">
                        <div className="flex justify-between font-semibold border-b pb-1 mb-1">
                            <span>Time</span>
                            <span>Open</span>
                            <span>Close</span>
                            <span>Vol</span>
                        </div>
                        {grCandles.slice().reverse().map((c, i) => (
                            <div key={i} className="flex justify-between py-1 border-b border-slate-100 last:border-0">
                                <span>{formatTime(c.ts)}</span>
                                <span>{c.open.toFixed(4)}</span>
                                <span>{c.close.toFixed(4)}</span>
                                <span>{c.volume.toFixed(2)}</span>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Bottom: Metrics & Logs */}
                <section className="col-span-12 bg-white rounded-2xl shadow p-4">
                    <h3 className="font-bold mb-3 flex items-center gap-2">
                        <AlertTriangle size={18} /> Comparator & Logs
                    </h3>
                    <div className="grid grid-cols-3 gap-4">
                        <div className="col-span-1 bg-slate-50 p-4 rounded-lg">
                            <div className="text-sm text-slate-500 mb-1">Candle Match %</div>
                            <div className="text-2xl font-bold">{metrics.matchedPct}%</div>

                            <div className="text-sm text-slate-500 mt-3 mb-1">Mean Price Diff (bps)</div>
                            <div className="text-2xl font-bold">{metrics.meanPriceBps.toFixed(2)}</div>
                        </div>
                        <div className="col-span-2 bg-black text-green-400 font-mono text-xs p-3 rounded-lg h-40 overflow-y-auto">
                            {logs.map((l, i) => (
                                <div key={i}>&gt; {l}</div>
                            ))}
                        </div>
                    </div>
                </section>
            </main>
        </div>
    );
};

export default GoldRushHyperliquidUI;
