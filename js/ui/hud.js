// In-game overlays: scorebug, box score, play-by-play, ticker and player inspector.
import { fmtClock } from '../util.js';
import { RATING_KEYS, RATING_LABELS } from '../sim/constants.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function pct(m, a) { return a ? `${Math.round((100 * m) / a)}` : '–'; }

export class Hud {
  constructor({ onSelectPlayer }) {
    this.onSelectPlayer = onSelectPlayer;
    this.game = null;
    this.lastEvent = 0;
    this.boxT = 0;
    this.inspT = 0;
    this.selected = null;
    this.tickerT = 0;
    document.querySelectorAll('#panel .tab').forEach((b) => {
      b.onclick = () => this.showTab(b.dataset.tab);
    });
    $('panel-toggle').onclick = () => { $('panel').classList.add('hidden'); $('panel-open').classList.remove('hidden'); };
    $('panel-open').onclick = () => { $('panel').classList.remove('hidden'); $('panel-open').classList.add('hidden'); };
    $('tab-box').addEventListener('pointerdown', (e) => {
      const tr = e.target.closest('tr.player');
      if (tr) this.onSelectPlayer(tr.dataset.id);
    });
  }

  showTab(tab) {
    document.querySelectorAll('#panel .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('tab-box').classList.toggle('hidden', tab !== 'box');
    $('tab-pbp').classList.toggle('hidden', tab !== 'pbp');
  }

  attach(game) {
    this.game = game;
    this.lastEvent = 0;
    $('pbp').innerHTML = '';
    for (const id of ['scorebug', 'panel', 'controls']) $(id).classList.remove('hidden');
    $('panel-open').classList.add('hidden');
    const [h, a] = game.teams;
    for (const [el, t] of [[$('sb-home'), h], [$('sb-away'), a]]) {
      el.querySelector('.sb-swatch').style.background = t.primary;
      el.querySelector('.sb-abbr').textContent = t.abbr;
      el.title = t.name;
    }
    this.renderBox();
  }

  select(player) {
    this.selected = player;
    this.renderInspector();
    this.renderBox();
  }

  update(dt) {
    const g = this.game;
    if (!g) return;
    this.renderScorebug();
    // new play-by-play events
    const evs = g.events;
    if (evs.length && evs[evs.length - 1].id > this.lastEvent) {
      const frag = document.createDocumentFragment();
      let newest = null;
      for (const e of evs) {
        if (e.id <= this.lastEvent) continue;
        this.lastEvent = e.id;
        const li = document.createElement('li');
        li.className = `k-${e.kind}`;
        const col = e.team != null ? g.teams[e.team].primary : 'transparent';
        li.innerHTML = `<span class="t">${g.periodName(e.period)} ${fmtClock(e.clock)}</span><span class="txt" style="border-left-color:${col}">${esc(e.text)}</span><span class="s">${e.score[0]}–${e.score[1]}</span>`;
        frag.appendChild(li);
        if (e.kind !== 'sub' && e.kind !== 'info') newest = e;
      }
      const list = $('pbp');
      list.appendChild(frag);
      while (list.children.length > 400) list.removeChild(list.firstChild);
      if (newest) this.showTicker(newest);
    }
    this.tickerT -= dt;
    if (this.tickerT <= 0) $('ticker').style.opacity = 0;
    this.boxT -= dt;
    if (this.boxT <= 0) { this.boxT = 0.6; this.renderBox(); }
    this.inspT -= dt;
    if (this.inspT <= 0) { this.inspT = 0.2; this.renderInspector(); }
  }

  showTicker(e) {
    const t = $('ticker');
    t.classList.remove('hidden');
    t.textContent = e.text;
    t.style.opacity = 1;
    this.tickerT = 3;
  }

  renderScorebug() {
    const g = this.game;
    const [h, a] = g.teams;
    for (const [el, t] of [[$('sb-home'), h], [$('sb-away'), a]]) {
      el.querySelector('.sb-score').textContent = t.score;
      const bonus = t.fouls >= 5;
      el.querySelector('.sb-fouls').innerHTML = `Fouls ${t.fouls}${bonus ? ' <span class="bonus">BONUS</span>' : ''}`;
      el.querySelector('.sb-tos').textContent = `TOL ${t.timeouts}`;
    }
    $('scorebug').querySelector('.sb-period').textContent = g.periodName();
    $('scorebug').querySelector('.sb-clock').textContent = fmtClock(g.clock);
    const shot = $('scorebug').querySelector('.sb-shot');
    const showShot = !g.over && g.offense != null && g.shotClock < g.clock + 0.01 && (g.phase === 'live' || g.phase === 'inbound');
    shot.textContent = showShot ? Math.ceil(Math.max(0, g.shotClock)) : '';
    shot.classList.toggle('low', g.shotClock <= 5);
    const status = g.statusText();
    const banner = $('banner');
    banner.classList.toggle('hidden', !status);
    banner.textContent = status;
  }

  renderBox() {
    const g = this.game;
    if (!g) return;
    const periods = Math.max(4, g.period);
    let html = '<table class="quarters"><tr><th></th>';
    for (let i = 1; i <= periods; i++) html += `<th>${i <= 4 ? i : i === 5 ? 'OT' : `${i - 4}OT`}</th>`;
    html += '<th>T</th></tr>';
    for (const t of g.teams) {
      html += `<tr><td>${esc(t.abbr)}</td>`;
      for (let i = 0; i < periods; i++) html += `<td>${i < g.period ? (t.periodScores[i] || 0) : ''}</td>`;
      html += `<td><b>${t.score}</b></td></tr>`;
    }
    html += '</table>';
    for (const t of g.teams) {
      html += `<div class="box-team"><h3><span class="dot" style="background:${t.primary}"></span>${esc(t.name)}<span class="pts">${t.score}</span></h3>`;
      html += '<table class="box"><thead><tr><th>Player</th><th>MIN</th><th>PTS</th><th>FG</th><th>3P</th><th>FT</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th><th>PF</th><th>+/-</th></tr></thead><tbody>';
      const tot = { min: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, tov: 0, pf: 0 };
      for (const p of t.roster) {
        const s = p.stats;
        for (const k in tot) tot[k] += s[k];
        const cls = ['player', p.onCourt ? 'oncourt' : '', p.fouledOut ? 'fouledout' : '', this.selected === p ? 'selected' : ''].join(' ');
        html += `<tr class="${cls}" data-id="${p.id}"><td><span class="pnum">${p.num}</span><span class="pname">${esc(p.name)}</span></td>`
          + `<td>${Math.floor(s.min / 60)}</td><td><b>${s.pts}</b></td><td>${s.fgm}-${s.fga}</td><td>${s.tpm}-${s.tpa}</td><td>${s.ftm}-${s.fta}</td>`
          + `<td>${s.oreb + s.dreb}</td><td>${s.ast}</td><td>${s.stl}</td><td>${s.blk}</td><td>${s.tov}</td><td>${s.pf}</td><td>${s.pm > 0 ? '+' : ''}${s.pm}</td></tr>`;
      }
      html += `<tr class="totals"><td>Team</td><td></td><td>${tot.pts}</td><td>${tot.fgm}-${tot.fga}</td><td>${tot.tpm}-${tot.tpa}</td><td>${tot.ftm}-${tot.fta}</td><td>${tot.oreb + tot.dreb}</td><td>${tot.ast}</td><td>${tot.stl}</td><td>${tot.blk}</td><td>${tot.tov}</td><td>${tot.pf}</td><td></td></tr>`;
      html += `<tr class="totals"><td colspan="13" style="text-align:left;font-weight:400;color:var(--muted)">FG ${pct(tot.fgm, tot.fga)}% · 3P ${pct(tot.tpm, tot.tpa)}% · FT ${pct(tot.ftm, tot.fta)}% · OREB ${tot.oreb}</td></tr>`;
      html += '</tbody></table></div>';
    }
    $('tab-box').innerHTML = html;
  }

  renderInspector() {
    const el = $('inspector');
    const p = this.selected;
    if (!p || !this.game) { el.classList.add('hidden'); return; }
    const team = this.game.teams[p.team];
    const s = p.stats;
    el.classList.remove('hidden');
    const bars = RATING_KEYS.map((k) => {
      const v = p.r[k];
      const c = v >= 85 ? '#4cc38a' : v >= 70 ? '#8fd14f' : v >= 55 ? '#ffb020' : '#ff6b5b';
      return `<span class="lbl">${RATING_LABELS[k]}</span><span class="bar"><i style="width:${v}%;background:${c}"></i></span><span class="val">${v}</span>`;
    }).join('');
    const stam = Math.round(p.stamina * 100);
    const stamC = stam > 80 ? '#4cc38a' : stam > 65 ? '#ffb020' : '#ff6b5b';
    const ft = Math.floor(p.heightCm / 30.48), inch = Math.round((p.heightCm / 2.54) % 12);
    el.innerHTML = `
      <div class="insp-head">
        <div class="insp-num" style="background:${team.primary};color:${team.secondary}">${p.num}</div>
        <div><div class="insp-name">${esc(p.name)}</div>
        <div class="insp-sub">${p.pos} · ${ft}'${inch}" (${p.heightCm} cm) · ${esc(team.abbr)} · OVR ${p.ovr}</div></div>
        <button class="icon-btn insp-close" aria-label="Close inspector">✕</button>
      </div>
      <div class="insp-intent"><b>${p.onCourt ? 'ON COURT' : p.fouledOut ? 'FOULED OUT' : 'ON THE BENCH'}</b>${esc(p.onCourt ? p.intent : p.fouledOut ? 'Done for the night' : 'Resting')}</div>
      <div class="bars stam"><span class="lbl">Stamina</span><span class="bar"><i style="width:${stam}%;background:${stamC}"></i></span><span class="val">${stam}</span></div>
      <div class="insp-line"><strong>${s.pts}</strong> PTS · <strong>${s.oreb + s.dreb}</strong> REB · <strong>${s.ast}</strong> AST · ${s.fgm}-${s.fga} FG · ${s.tpm}-${s.tpa} 3P · ${p.fouls} PF · ${Math.floor(s.min / 60)} MIN</div>
      <div class="bars">${bars}</div>`;
    el.querySelector('.insp-close').onclick = () => this.onSelectPlayer(null);
  }
}
