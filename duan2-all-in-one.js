'use strict';
// ═══════════════════════════════════════════════════════════════════
//  DUAN2 — ALL-IN-ONE
//  Chạy: node duan2-all-in-one.js
//  Requires: npm install express
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const https   = require('https');
const http    = require('http');

// ── PORT CONFIG ──────────────────────────────────────────────────────
const GATEWAY_PORT  = process.env.PORT || 5001;
const PORTS = {
    sunwin2:   6100,
    hitclub2:  6101,
    lc792:     6102,
    betvip2:   6103,
    b522:      6104,
    max7892:   6105,
    baccarat2: 6106,
    '68gb2':   6107,
};

// ════════════════════════════════════════════════════════════════════
//  ENGINE (inline)
// ════════════════════════════════════════════════════════════════════
const weights  = {};   // { game: { [key]: { T:0, X:0 } } }
const predLogs = {};   // { game: [ { phien, du_doan, ket_qua, dung, thoi_gian } ] }
const MAX_LOG  = 50;

function normalize(str) {
    if (!str) return null;
    const s = String(str).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
    if (s === 'tai' || s === 't') return 'T';
    if (s === 'xiu' || s === 'x') return 'X';
    if (s === 'b' || s === 'banker') return 'B';
    if (s === 'p' || s === 'player') return 'P';
    if (s === 'tai') return 'T';
    return null;
}

function fromSum(sum, type) {
    if (sum === null || sum === undefined) return null;
    const n = Number(sum);
    if (isNaN(n)) return null;
    if (type === 'tx')     return n >= 11 ? 'T' : 'X';
    if (type === 'md5')    return n % 2 === 0 ? 'X' : 'T';
    if (type === 'sicbo')  return n >= 11 ? 'T' : 'X';
    if (type === 'xocdia') return n >= 2 ? 'T' : 'X'; // 2-4 chấn = Chẵn=Tài
    return null;
}

function updateWeights(game, hist) {
    if (!weights[game]) weights[game] = {};
    const w = weights[game];
    for (let order = 1; order <= 3; order++) {
        if (hist.length < order + 1) continue;
        const key = hist.slice(0, order).map(h => h.winner).join('');
        if (!w[key]) w[key] = { T: 0, X: 0, B: 0, P: 0 };
        const next = hist[order]?.winner;
        if (next && w[key][next] !== undefined) w[key][next]++;
    }
}

function predict(hist, game) {
    if (hist.length < 3) return { du_doan: 'T', do_tin_cay: 50, loai_cau: 'Chưa đủ dữ liệu' };
    updateWeights(game, hist);

    const recent = hist.slice(0, 20).map(h => h.winner);
    const votes  = { T: 0, X: 0 };
    const models = [];

    // Markov 1,2,3
    for (let order = 1; order <= 3; order++) {
        const key = recent.slice(0, order).join('');
        const w   = (weights[game] || {})[key];
        if (w) {
            const tScore = (w.T || 0), xScore = (w.X || 0);
            const total  = tScore + xScore;
            if (total >= 2) {
                const pred = tScore >= xScore ? 'T' : 'X';
                const wt   = [1.5, 1.2, 1.0][order - 1];
                votes[pred] = (votes[pred] || 0) + wt;
                models.push(`M${order}→${pred}`);
            }
        }
    }

    // Streak
    let streakLen = 1, streakVal = recent[0];
    for (let i = 1; i < Math.min(recent.length, 15); i++) {
        if (recent[i] === streakVal) streakLen++;
        else break;
    }
    const streakPred = streakLen >= 4
        ? (streakVal === 'T' ? 'X' : 'T')
        : streakVal;
    votes[streakPred] = (votes[streakPred] || 0) + 1.3;
    models.push(`Chuỗi${streakLen}→${streakPred}`);

    // Frequency
    const tCount = recent.filter(r => r === 'T').length;
    const freqPred = tCount > recent.length * 0.65 ? 'X'
                   : tCount < recent.length * 0.35 ? 'T'
                   : tCount >= recent.length / 2 ? 'T' : 'X';
    votes[freqPred] = (votes[freqPred] || 0) + 1.0;

    // Alternating
    let isAlt = true;
    for (let i = 0; i < Math.min(recent.length - 1, 4); i++) {
        if (recent[i] === recent[i + 1]) { isAlt = false; break; }
    }
    if (isAlt && recent.length >= 4) {
        const altPred = recent[0] === 'T' ? 'X' : 'T';
        votes[altPred] = (votes[altPred] || 0) + 1.0;
        models.push(`Lc→${altPred}`);
    }

    const tV = votes.T || 0, xV = votes.X || 0;
    const total = tV + xV || 1;
    const winner = tV >= xV ? 'T' : 'X';
    const conf   = Math.min(Math.round(Math.max(tV, xV) / total * 100 + 3), 97);
    const label  = winner === 'T' ? 'Tài' : 'Xỉu';

    const pattern = models.slice(0, 3).join('/');
    const loaiCau = `${models.length} models → ${label}(${conf}%) [Học:${Object.keys(weights[game]||{}).length}mẫu/chuỗi${streakLen}]✓`;

    return { du_doan: label, do_tin_cay: conf, loai_cau: loaiCau };
}

function logPred(game, phien, du_doan) {
    if (!predLogs[game]) predLogs[game] = [];
    const log = predLogs[game];
    if (log.some(l => l.phien === phien)) return;
    log.unshift({ phien, du_doan, ket_qua: '?', dung: null, thoi_gian: new Date().toISOString() });
    if (log.length > MAX_LOG) predLogs[game] = log.slice(0, MAX_LOG);
}

function updateActual(game, phien, actual) {
    if (!predLogs[game]) return;
    const entry = predLogs[game].find(l => l.phien === phien);
    if (!entry || entry.ket_qua !== '?') return;
    const rawActual = actual === 'T' ? 'T' : actual === 'X' ? 'X' : actual;
    const rawPred   = entry.du_doan === 'Tài' ? 'T' : entry.du_doan === 'Xỉu' ? 'X' : entry.du_doan;
    entry.ket_qua = rawActual;
    entry.dung    = rawPred === rawActual;
}

function getLog(game) {
    const log = predLogs[game] || [];
    const done = log.filter(l => l.dung !== null);
    const thang = done.filter(l => l.dung).length;
    const thua  = done.filter(l => !l.dung).length;
    return {
        game,
        thang, thua,
        tong: done.length,
        pct:  done.length ? Math.round(thang / done.length * 100) : null,
        lichsu: log
    };
}

function getMarkovStats(game) {
    const w = weights[game] || {};
    return { total_patterns: Object.keys(w).length, patterns: w };
}

// ════════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ════════════════════════════════════════════════════════════════════
function fetchJson(url, cb) {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { try { cb(null, JSON.parse(data)); } catch(e) { cb(e); } });
    });
    req.on('error', cb);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
}

function makePollTX(url, histArr, gameKey) {
    return function poll() {
        fetchJson(url, (err, data) => {
            if (err || !data) return;
            let list = Array.isArray(data) ? data
                     : Array.isArray(data.data) ? data.data
                     : Array.isArray(data.result) ? data.result
                     : (data.phien !== undefined ? [data] : []);
            if (!list.length) return;
            const newItems = [];
            list.forEach(item => {
                const winner = normalize(item.ket_qua) || fromSum(item.tong, 'tx');
                if (!winner) return;
                const phien = Number(item.phien);
                if (!histArr.some(h => h.phien === phien))
                    newItems.push({ phien, winner, tong: item.tong });
            });
            if (newItems.length) {
                newItems.forEach(p => updateActual(gameKey, p.phien, p.winner));
                histArr.unshift(...newItems);
                if (histArr.length > 200) histArr.splice(200);
            }
        });
    };
}

function makePollSICBO(url, histArr, gameKey) {
    return function poll() {
        fetchJson(url, (err, data) => {
            if (err || !data) return;
            let list = Array.isArray(data) ? data
                     : Array.isArray(data.data) ? data.data
                     : Array.isArray(data.result) ? data.result
                     : (data.phien !== undefined ? [data] : []);
            if (!list.length) return;
            const newItems = [];
            list.forEach(item => {
                const winner = normalize(item.ket_qua) || fromSum(item.tong, 'sicbo');
                if (!winner) return;
                const phien = Number(String(item.phien || '').replace('#', ''));
                if (!histArr.some(h => h.phien === phien))
                    newItems.push({ phien, winner, tong: item.tong });
            });
            if (newItems.length) {
                newItems.forEach(p => updateActual(gameKey, p.phien, p.winner));
                histArr.unshift(...newItems);
                if (histArr.length > 200) histArr.splice(200);
            }
        });
    };
}

function startPolling(pollFn, interval) {
    pollFn();
    setInterval(pollFn, interval || 3000);
}

function makePredRoute(histArr, gameKey) {
    return (req, res) => {
        if (!histArr.length) return res.json({ error: 'Chưa có dữ liệu' });
        const result = predict(histArr, gameKey);
        const latest = histArr[0];
        logPred(gameKey, latest.phien + 1, result.du_doan);
        res.json({
            phien: latest.phien + 1,
            du_doan: result.du_doan,
            do_tin_cay: result.do_tin_cay,
            loai_cau: result.loai_cau,
            phien_truoc: { phien: latest.phien, ket_qua: latest.winner, tong: latest.tong }
        });
    };
}

// ════════════════════════════════════════════════════════════════════
//  GAME SERVICES (mỗi game 1 Express app, cổng riêng)
// ════════════════════════════════════════════════════════════════════

// ── SUNWIN2 (port 6100) ───────────────────────────────────────────
{
    const app = express();
    const h = { tx: [], sicbo: [] };
    const CF_TX    = 'https://amongst-plots-called-dining.trycloudflare.com/api/tx';
    const CF_SICBO = 'https://ent-glenn-terrain-project.trycloudflare.com/sicbo/sunwin';

    startPolling(makePollTX(CF_TX, h.tx, 'sunwin2_tx'));
    startPolling(makePollSICBO(CF_SICBO, h.sicbo, 'sunwin2_sicbo'));

    app.get('/api/tx',    makePredRoute(h.tx,    'sunwin2_tx'));
    app.get('/api/hu',    makePredRoute(h.tx,    'sunwin2_tx'));
    app.get('/api/sicbo', makePredRoute(h.sicbo, 'sunwin2_sicbo'));
    app.get('/api/pred-log', (req, res) => res.json(getLog(req.query.game || 'sunwin2_tx')));
    app.get('/', (req, res) => res.json({ service: 'SunWin2', port: PORTS.sunwin2 }));
    app.listen(PORTS.sunwin2, () => console.log(`[sunwin2] port ${PORTS.sunwin2}`));
}

// ── HITCLUB2 (port 6101) ──────────────────────────────────────────
{
    const app = express();
    const h = { tx: [], md5: [], sicbo: [] };
    const CF_TX    = 'https://gossip-marriage-anime-variance.trycloudflare.com/api/tx';
    const CF_MD5   = 'https://gossip-marriage-anime-variance.trycloudflare.com/api/txmd5';
    const CF_SICBO = 'https://ent-glenn-terrain-project.trycloudflare.com/sicbo/hitclub';

    startPolling(makePollTX(CF_TX,    h.tx,    'hitclub2_tx'));
    startPolling(makePollTX(CF_MD5,   h.md5,   'hitclub2_md5'));
    startPolling(makePollSICBO(CF_SICBO, h.sicbo, 'hitclub2_sicbo'));

    app.get('/api/tx',    makePredRoute(h.tx,    'hitclub2_tx'));
    app.get('/api/hu',    makePredRoute(h.tx,    'hitclub2_tx'));
    app.get('/api/md5',   makePredRoute(h.md5,   'hitclub2_md5'));
    app.get('/api/sicbo', makePredRoute(h.sicbo, 'hitclub2_sicbo'));
    app.get('/api/pred-log', (req, res) => res.json(getLog(req.query.game || 'hitclub2_tx')));
    app.get('/', (req, res) => res.json({ service: 'HitClub2', port: PORTS.hitclub2 }));
    app.listen(PORTS.hitclub2, () => console.log(`[hitclub2] port ${PORTS.hitclub2}`));
}

// ── LC792 (port 6102) ─────────────────────────────────────────────
{
    const app = express();
    const h = { tx: [], md5: [], xocdia: [] };
    const CF_TX     = 'https://reported-prot-prefers-cattle.trycloudflare.com/api/tx';
    const CF_MD5    = 'https://reported-prot-prefers-cattle.trycloudflare.com/api/txmd5';
    const CF_XOCDIA = 'https://reported-prot-prefers-cattle.trycloudflare.com/api/xocdia';

    // Xocdia poll riêng
    function pollXocdia() {
        fetchJson(CF_XOCDIA, (err, data) => {
            if (err || !data) return;
            let list = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : (data.phien !== undefined ? [data] : []);
            if (!list.length) return;
            const newItems = [];
            list.forEach(item => {
                let chanCount = 0;
                if (item.xuc_xac_1 !== undefined) {
                    [item.xuc_xac_1, item.xuc_xac_2, item.xuc_xac_3, item.xuc_xac_4].forEach(v => { if (v !== undefined && v % 2 === 0) chanCount++; });
                } else if (item.tong !== undefined) { chanCount = item.tong; }
                const winner = fromSum(chanCount, 'xocdia');
                if (!winner) return;
                const phien = Number(item.phien);
                if (!h.xocdia.some(x => x.phien === phien)) newItems.push({ phien, winner, tong: chanCount });
            });
            if (newItems.length) {
                newItems.forEach(p => updateActual('lc792_xocdia', p.phien, p.winner));
                h.xocdia.unshift(...newItems);
                if (h.xocdia.length > 200) h.xocdia.splice(200);
            }
        });
    }

    startPolling(makePollTX(CF_TX,  h.tx,  'lc792_tx'));
    startPolling(makePollTX(CF_MD5, h.md5, 'lc792_md5'));
    startPolling(pollXocdia);

    app.get('/api/tx',     makePredRoute(h.tx,     'lc792_tx'));
    app.get('/api/hu',     makePredRoute(h.tx,     'lc792_tx'));
    app.get('/api/md5',    makePredRoute(h.md5,    'lc792_md5'));
    app.get('/api/xocdia', makePredRoute(h.xocdia, 'lc792_xocdia'));
    app.get('/api/pred-log', (req, res) => res.json(getLog(req.query.game || 'lc792_tx')));
    app.get('/', (req, res) => res.json({ service: 'LC792', port: PORTS.lc792 }));
    app.listen(PORTS.lc792, () => console.log(`[lc792] port ${PORTS.lc792}`));
}

// ── BETVIP2 (port 6103) ───────────────────────────────────────────
{
    const app = express();
    const h = { tx: [], md5: [] };
    const CF_TX  = 'https://paying-hon-bullet-sms.trycloudflare.com/api/tx';
    const CF_MD5 = 'https://paying-hon-bullet-sms.trycloudflare.com/api/txmd5';

    startPolling(makePollTX(CF_TX,  h.tx,  'betvip2_tx'));
    startPolling(makePollTX(CF_MD5, h.md5, 'betvip2_md5'));

    app.get('/api/tx',  makePredRoute(h.tx,  'betvip2_tx'));
    app.get('/api/hu',  makePredRoute(h.tx,  'betvip2_tx'));
    app.get('/api/md5', makePredRoute(h.md5, 'betvip2_md5'));
    app.get('/api/pred-log', (req, res) => res.json(getLog(req.query.game || 'betvip2_tx')));
    app.get('/', (req, res) => res.json({ service: 'BetVip2', port: PORTS.betvip2 }));
    app.listen(PORTS.betvip2, () => console.log(`[betvip2] port ${PORTS.betvip2}`));
}

// ── B522 (port 6104) ──────────────────────────────────────────────
{
    const app = express();
    const h = { tx: [], md5: [], sicbo: [] };
    const CF_TX    = 'https://volunteers-executives-granted-liz.trycloudflare.com/taixiu';
    const CF_MD5   = 'https://volunteers-executives-granted-liz.trycloudflare.com/txmd5';
    const CF_SICBO = 'https://ent-glenn-terrain-project.trycloudflare.com/sicbo/b52';

    startPolling(makePollTX(CF_TX,    h.tx,    'b522_tx'));
    startPolling(makePollTX(CF_MD5,   h.md5,   'b522_md5'));
    startPolling(makePollSICBO(CF_SICBO, h.sicbo, 'b522_sicbo'));

    app.get('/api/tx',    makePredRoute(h.tx,    'b522_tx'));
    app.get('/api/hu',    makePredRoute(h.tx,    'b522_tx'));
    app.get('/api/md5',   makePredRoute(h.md5,   'b522_md5'));
    app.get('/api/sicbo', makePredRoute(h.sicbo, 'b522_sicbo'));
    app.get('/api/pred-log', (req, res) => res.json(getLog(req.query.game || 'b522_tx')));
    app.get('/', (req, res) => res.json({ service: 'B522', port: PORTS.b522 }));
    app.listen(PORTS.b522, () => console.log(`[b522] port ${PORTS.b522}`));
}

// ── MAX7892 (port 6105) ───────────────────────────────────────────
{
    const app = express();
    const h = { tx: [], md5: [] };
    const CF_TX  = 'https://person-talent-mission-opening.trycloudflare.com/api/tx';
    const CF_MD5 = 'https://person-talent-mission-opening.trycloudflare.com/api/txmd5';

    startPolling(makePollTX(CF_TX,  h.tx,  'max7892_tx'));
    startPolling(makePollTX(CF_MD5, h.md5, 'max7892_md5'));

    app.get('/api/tx',  makePredRoute(h.tx,  'max7892_tx'));
    app.get('/api/hu',  makePredRoute(h.tx,  'max7892_tx'));
    app.get('/api/md5', makePredRoute(h.md5, 'max7892_md5'));
    app.get('/api/pred-log', (req, res) => res.json(getLog(req.query.game || 'max7892_tx')));
    app.get('/', (req, res) => res.json({ service: 'Max7892', port: PORTS.max7892 }));
    app.listen(PORTS.max7892, () => console.log(`[max7892] port ${PORTS.max7892}`));
}

// ── BACCARAT2 (port 6106) ─────────────────────────────────────────
{
    const app = express();
    const tables = {};
    const CF_BCR = 'https://construct-vacuum-bosnia-travel.trycloudflare.com/api/bcr';

    function parseResults(str) {
        if (!str) return [];
        return str.split('').map(c => c === 'B' ? 'B' : c === 'P' ? 'P' : c === 'T' ? 'TIE' : null).filter(Boolean);
    }

    function predictBaccarat(hist) {
        const results = hist.map(h => h.winner).filter(r => r !== 'TIE');
        const m = results.length;
        if (m < 3) return { du_doan: null, do_tin_cay: 0, loai_cau: 'Chưa đủ dữ liệu' };
        const votes = { B: 0, P: 0 };
        function markov(order) {
            if (m < order + 1) return null;
            const key = results.slice(0, order).join('');
            let b = 0, p = 0;
            for (let i = order; i < m; i++) {
                if (results.slice(i-order, i).join('') === key) results[i] === 'B' ? b++ : p++;
            }
            if (b + p < 2) return null;
            return b > p ? 'B' : 'P';
        }
        function streak() {
            let cur = results[0], cnt = 1;
            for (let i = 1; i < Math.min(m, 10); i++) { if (results[i] === cur) cnt++; else break; }
            return cnt >= 4 ? (cur === 'B' ? 'P' : 'B') : cur;
        }
        function frequency(w) {
            const s = results.slice(0, Math.min(m, w));
            const b = s.filter(r => r === 'B').length;
            const ratio = b / s.length;
            if (ratio > 0.65) return 'P'; if (ratio < 0.35) return 'B';
            return b >= s.length - b ? 'B' : 'P';
        }
        function pattern3() {
            if (m < 4) return null;
            const key = results.slice(0, 3).join('');
            const mm = [];
            for (let i = 3; i < m; i++) if (results.slice(i-3,i).join('') === key) mm.push(results[i]);
            if (mm.length < 2) return null;
            return mm.filter(r => r === 'B').length > mm.length / 2 ? 'B' : 'P';
        }
        function alternating() {
            if (m < 5) return null;
            for (let i = 0; i < 4; i++) if (results[i] === results[i+1]) return null;
            return results[0] === 'B' ? 'P' : 'B';
        }
        function momentum() {
            let score = 0;
            results.slice(0, Math.min(m, 10)).forEach((r, i) => { score += r === 'B' ? 1/(i+1) : -1/(i+1); });
            return score > 0 ? 'B' : 'P';
        }
        const preds = [markov(1), markov(2), markov(3), streak(), frequency(20), frequency(50), pattern3(), alternating(), momentum()];
        const wts   = [1.5, 1.2, 1.0, 1.3, 1.0, 0.8, 1.1, 1.0, 1.2];
        preds.forEach((pred, i) => { if (pred) votes[pred] = (votes[pred]||0) + wts[i]; });
        const total  = (votes.B||0) + (votes.P||0);
        const bScore = (votes.B||0) / (total||1);
        const winner = bScore >= 0.5 ? 'B' : 'P';
        const conf   = Math.min(Math.round(Math.max(bScore, 1-bScore)*100 + 3), 97);
        const s3     = results.slice(0,5).filter((r,i,a) => r === a[0]).length;
        const loai   = winner === 'B' ? 'Banker' : 'Player';
        return { du_doan: winner, loai, do_tin_cay: conf, loai_cau: s3 >= 4 ? `Cầu bệt ${s3} → ${loai}` : `Ensemble → ${loai}(${conf}%)` };
    }

    function pollBCR() {
        fetchJson(CF_BCR, (err, data) => {
            if (err || !data) return;
            const list = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
            list.forEach(item => {
                if (!item.results || !item.ban) return;
                const ban = String(item.ban);
                const parsed = parseResults(item.results);
                if (parsed.length) tables[ban] = parsed.slice(0, 300).map((w, i) => ({ phien: i, winner: w }));
            });
        });
    }

    setInterval(pollBCR, 3000); pollBCR();

    app.get('/api/baccarat', (req, res) => {
        const banQuery = req.query.ban ? String(req.query.ban) : null;
        let ban, hist;
        if (banQuery) {
            if (!tables[banQuery]) return res.json({ error: `Không có bàn ${banQuery}` });
            ban = banQuery; hist = tables[banQuery];
        } else {
            const keys = Object.keys(tables);
            if (!keys.length) return res.json({ error: 'Chưa có dữ liệu' });
            ban = keys.reduce((a, b) => tables[a].length >= tables[b].length ? a : b);
            hist = tables[ban];
        }
        if (!hist || hist.length < 3) return res.json({ error: 'Chưa đủ dữ liệu' });
        const result = predictBaccarat(hist);
        res.json({ ban, ...result, lich_su_gan: hist.slice(0,15).map(h => h.winner), tong_ket_qua: hist.length });
    });
    app.get('/api/baccarat/tables', (req, res) => {
        const list = Object.keys(tables).map(ban => ({ ban, so_ket_qua: tables[ban].length, gan_nhat: tables[ban].slice(0,5).map(h => h.winner) }));
        res.json({ total_ban: list.length, tables: list });
    });
    app.get('/api/bcr', (req, res) => res.redirect('/api/baccarat' + (req.query.ban ? '?ban='+req.query.ban : '')));
    app.get('/api/pred-log', (req, res) => res.json(getLog('baccarat2')));
    app.get('/', (req, res) => res.json({ service: 'Baccarat2', port: PORTS.baccarat2 }));
    app.listen(PORTS.baccarat2, () => console.log(`[baccarat2] port ${PORTS.baccarat2}`));
}

// ── 68GB2 (port 6107) ─────────────────────────────────────────────
{
    const app = express();
    const h = { tx: [], md5: [] };
    const CF_TX  = 'https://winds-fonts-seq-jaguar.trycloudflare.com/api/68/thuong';
    const CF_MD5 = 'https://objectives-scanning-list-reliance.trycloudflare.com/api/68/md5';

    startPolling(makePollTX(CF_TX,  h.tx,  '68gb2_tx'));
    startPolling(makePollTX(CF_MD5, h.md5, '68gb2_md5'));

    app.get('/api/tx',  makePredRoute(h.tx,  '68gb2_tx'));
    app.get('/api/hu',  makePredRoute(h.tx,  '68gb2_tx'));
    app.get('/api/md5', makePredRoute(h.md5, '68gb2_md5'));
    app.get('/api/pred-log', (req, res) => res.json(getLog(req.query.game || '68gb2_tx')));
    app.get('/', (req, res) => res.json({ service: '68GB2', port: PORTS['68gb2'] }));
    app.listen(PORTS['68gb2'], () => console.log(`[68gb2] port ${PORTS['68gb2']}`));
}

// ════════════════════════════════════════════════════════════════════
//  GATEWAY (port 5001)
// ════════════════════════════════════════════════════════════════════
const gateway = express();

const SERVICES = {
    sunwin2:   { port: PORTS.sunwin2,   routes: ['tx','hu','sicbo'] },
    hitclub2:  { port: PORTS.hitclub2,  routes: ['tx','hu','md5','sicbo'] },
    lc792:     { port: PORTS.lc792,     routes: ['tx','hu','md5','xocdia'] },
    betvip2:   { port: PORTS.betvip2,   routes: ['tx','hu','md5'] },
    b522:      { port: PORTS.b522,      routes: ['tx','hu','md5','sicbo'] },
    max7892:   { port: PORTS.max7892,   routes: ['tx','hu','md5'] },
    baccarat2: { port: PORTS.baccarat2, routes: ['baccarat','bcr','baccarat/tables'] },
    '68gb2':   { port: PORTS['68gb2'],  routes: ['tx','hu','md5'] },
};

function proxyTo(targetPort, targetPath) {
    return (req, res) => {
        const path  = targetPath || req.url;
        const query = Object.keys(req.query).length ? '?' + new URLSearchParams(req.query).toString() : '';
        const opts  = { hostname: '127.0.0.1', port: targetPort, path: path + query, method: 'GET', headers: { 'User-Agent': 'Gateway/1.0' } };
        const pr = http.request(opts, pres => {
            res.status(pres.statusCode);
            Object.entries(pres.headers).forEach(([k,v]) => { if (k !== 'transfer-encoding') res.setHeader(k, v); });
            pres.pipe(res);
        });
        pr.on('error', err => res.status(502).json({ error: 'Service unavailable', detail: err.message }));
        pr.setTimeout(10000, () => { pr.destroy(); res.status(504).json({ error: 'Gateway timeout' }); });
        pr.end();
    };
}

Object.entries(SERVICES).forEach(([gameName, { port, routes }]) => {
    routes.forEach(route => {
        gateway.get(`/api/${gameName}/${route}`, proxyTo(port, `/api/${route}`));
    });
    gateway.get(`/api/${gameName}/pred-log`, proxyTo(port, '/api/pred-log'));
});

function handlePredLog(req, res) {
    const game  = req.query.game || '';
    const limit = parseInt(req.query.limit) || 50;
    const ALIAS = { sunwin: 'sunwin2', hitclub: 'hitclub2', lc79: 'lc792', betvip: 'betvip2', b52: 'b522', max789: 'max7892', '68gb': '68gb2', baccarat: 'baccarat2' };
    let svcName = Object.keys(SERVICES).find(s => game.startsWith(s));
    if (!svcName) { const ak = Object.keys(ALIAS).find(a => game.startsWith(a)); if (ak) svcName = ALIAS[ak]; }
    if (!svcName) return res.status(400).json({ error: 'Unknown game', hint: 'Use ?game=sunwin2_tx', available: Object.keys(SERVICES) });

    const port = SERVICES[svcName].port;
    const opts = { hostname: '127.0.0.1', port, path: '/api/pred-log', method: 'GET', headers: { 'User-Agent': 'Gateway/1.0' } };
    const pr = http.request(opts, pres => {
        let raw = '';
        pres.on('data', d => raw += d);
        pres.on('end', () => {
            try {
                const data = JSON.parse(raw);
                if (data.lichsu && Array.isArray(data.lichsu)) data.lichsu = data.lichsu.slice(0, limit);
                res.json(data);
            } catch(e) { res.status(502).json({ error: 'Parse error' }); }
        });
    });
    pr.on('error', err => res.status(502).json({ error: 'Service unavailable', detail: err.message }));
    pr.setTimeout(8000, () => { pr.destroy(); res.status(504).json({ error: 'Gateway timeout' }); });
    pr.end();
}

gateway.get('/api/pred-log',  handlePredLog);
gateway.get('/api/pred-log2', handlePredLog);

gateway.get('/api/markov-stats', (req, res) => {
    const game = req.query.game;
    if (!game) return res.status(400).json({ error: 'Thiếu ?game=sunwin2_tx' });
    res.json({ game, ...getMarkovStats(game) });
});

gateway.get('/', (req, res) => {
    const endpoints = [];
    Object.entries(SERVICES).forEach(([name, { routes: r }]) => {
        r.forEach(route => endpoints.push(`/api/${name}/${route}`));
        endpoints.push(`/api/${name}/pred-log`);
    });
    res.json({ service: 'DuAn2 Gateway', port: GATEWAY_PORT, games: Object.keys(SERVICES), endpoints, pred_log: '/api/pred-log?game={gameName}_{type}&limit=50' });
});

gateway.listen(GATEWAY_PORT, () => {
    console.log(`\n[Gateway] DuAn2 All-In-One running on port ${GATEWAY_PORT}`);
    console.log('[Gateway] Games:', Object.keys(SERVICES).join(', '));
});
