// Team storage (presets + the viewer's saved edits) and the roster editor modal.
import { PRESET_TEAMS, overall, cloneTeam } from '../data/teams.js';
import { RATING_KEYS, RATING_SHORT, RATING_LABELS, POS_ORDER } from '../sim/constants.js';

const KEY = 'hardwood.teams.v1';

function readSaved() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeSaved(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

export function allTeams() {
  const saved = readSaved();
  const list = PRESET_TEAMS.map((t) => (saved[t.key] ? { ...saved[t.key], key: t.key, edited: true } : cloneTeam(t)));
  for (const k in saved) {
    if (!PRESET_TEAMS.some((t) => t.key === k)) list.push({ ...saved[k], key: k, edited: true, custom: true });
  }
  return list;
}

export function saveTeam(team) {
  const saved = readSaved();
  const copy = cloneTeam(team);
  delete copy.edited;
  delete copy.custom;
  saved[team.key] = copy;
  return writeSaved(saved);
}

export function resetTeam(key) {
  const saved = readSaved();
  delete saved[key];
  writeSaved(saved);
  return PRESET_TEAMS.find((t) => t.key === key);
}

export function validateTeam(t) {
  if (!t || typeof t !== 'object') throw new Error('Not a team object');
  if (!Array.isArray(t.players) || t.players.length < 5) throw new Error('A team needs at least 5 players');
  const players = t.players.slice(0, 15).map((p, i) => {
    const ratings = {};
    for (const k of RATING_KEYS) {
      const v = Number(p.ratings && p.ratings[k]);
      ratings[k] = Number.isFinite(v) ? Math.max(25, Math.min(99, Math.round(v))) : 60;
    }
    return {
      name: String(p.name || `Player ${i + 1}`).slice(0, 40),
      num: Math.max(0, Math.min(99, Math.round(Number(p.num) || i))),
      pos: POS_ORDER.includes(p.pos) ? p.pos : POS_ORDER[i % 5],
      height: Math.max(160, Math.min(235, Math.round(Number(p.height) || 200))),
      ratings,
    };
  });
  const hex = (c, d) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : d);
  return {
    key: String(t.key || `custom-${Date.now()}`),
    name: String(t.name || 'Custom Team').slice(0, 40),
    abbr: String(t.abbr || 'CUS').slice(0, 4).toUpperCase(),
    primary: hex(t.primary, '#445566'),
    secondary: hex(t.secondary, '#ffffff'),
    players,
  };
}

export class Editor {
  constructor(onSaved) {
    this.onSaved = onSaved;
    this.el = document.getElementById('editor');
    this.table = document.getElementById('ed-table');
    document.getElementById('ed-cancel').onclick = () => this.close();
    document.getElementById('ed-save').onclick = () => this.save();
    document.getElementById('ed-reset').onclick = () => {
      const t = resetTeam(this.team.key);
      if (t) { this.team = cloneTeam(t); this.render(); this.onSaved(this.team); }
    };
    document.getElementById('ed-export').onclick = () => this.exportJson();
    const file = document.getElementById('ed-file');
    document.getElementById('ed-import').onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      try {
        const t = validateTeam(JSON.parse(await f.text()));
        t.key = this.team.key;
        this.team = t;
        this.render();
      } catch (e) {
        alert(`Could not import that file: ${e.message}`);
      }
    };
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
  }

  open(team) {
    this.team = cloneTeam(team);
    this.render();
    this.el.classList.remove('hidden');
  }

  close() { this.el.classList.add('hidden'); }

  render() {
    const t = this.team;
    document.getElementById('ed-name').value = t.name;
    document.getElementById('ed-abbr').value = t.abbr;
    document.getElementById('ed-primary').value = t.primary;
    document.getElementById('ed-secondary').value = t.secondary;
    const head = `<tr><th>#</th><th>Name</th><th>Pos</th><th>Ht</th>${RATING_KEYS.map((k) => `<th title="${RATING_LABELS[k]}">${RATING_SHORT[k]}</th>`).join('')}<th>OVR</th></tr>`;
    const rows = t.players.map((p, i) => `
      <tr data-i="${i}">
        <td><input type="number" data-f="num" min="0" max="99" value="${p.num}" /></td>
        <td><input class="name-in" data-f="name" value="${escapeAttr(p.name)}" /></td>
        <td><select data-f="pos">${POS_ORDER.map((ps) => `<option ${ps === p.pos ? 'selected' : ''}>${ps}</option>`).join('')}</select></td>
        <td><input type="number" data-f="height" min="160" max="235" value="${p.height}" /></td>
        ${RATING_KEYS.map((k) => `<td><input type="number" data-r="${k}" min="25" max="99" value="${p.ratings[k]}" /></td>`).join('')}
        <td class="ovr">${overall(p)}</td>
      </tr>`).join('');
    this.table.innerHTML = head + rows;
    this.table.oninput = (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const p = t.players[+tr.dataset.i];
      const inp = e.target;
      if (inp.dataset.r) p.ratings[inp.dataset.r] = Math.max(25, Math.min(99, Math.round(+inp.value || 25)));
      else if (inp.dataset.f === 'name') p.name = inp.value;
      else if (inp.dataset.f === 'pos') p.pos = inp.value;
      else if (inp.dataset.f) p[inp.dataset.f] = Math.round(+inp.value || 0);
      tr.querySelector('.ovr').textContent = overall(p);
    };
  }

  collect() {
    const t = this.team;
    t.name = document.getElementById('ed-name').value.trim() || t.name;
    t.abbr = (document.getElementById('ed-abbr').value.trim() || t.abbr).toUpperCase().slice(0, 4);
    t.primary = document.getElementById('ed-primary').value;
    t.secondary = document.getElementById('ed-secondary').value;
    return validateTeam(t);
  }

  save() {
    const t = this.collect();
    t.key = this.team.key;
    if (!saveTeam(t)) alert('Your browser blocked local storage, so the edits will only last for this session.');
    this.onSaved(t);
    this.close();
  }

  exportJson() {
    const t = this.collect();
    const blob = new Blob([JSON.stringify(t, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${t.abbr.toLowerCase()}-roster.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
