/**
 * pi-workhouse: Palantir Cockpit Client Script
 */

let activeChannel = 'ALL';
let lastMessages = [];

function updateClock() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toTimeString().split(' ')[0] + ' UTC';
}
setInterval(updateClock, 1000);
updateClock();

function setChannel(chan) {
  activeChannel = chan;
  document.querySelectorAll('.comms-tab').forEach(t => {
    t.classList.toggle('active', t.getAttribute('data-chan') === chan);
  });
  renderComms(lastMessages);
}

async function fetchState() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    if (!data.ok) return;

    document.getElementById('node-count').textContent = data.sessions.length;
    document.getElementById('artifact-count').textContent = data.artifacts.length;
    document.getElementById('topo-tag').textContent = data.sessions.length + ' ACTIVE';
    document.getElementById('task-tag').textContent = data.tasks.length + ' TASKS';
    document.getElementById('lock-tag').textContent = data.locks.length + ' MUTEX';
    document.getElementById('art-tag').textContent = data.artifacts.length + ' ASSETS';

    if (data.hub) {
      document.getElementById('hub-badge').textContent = 'HUB: ' + data.hub.name;
    }

    renderTopology(data.sessions);
    renderTasks(data.tasks);
    renderLocks(data.locks);
    renderArtifacts(data.artifacts);

    lastMessages = data.messages;
    renderComms(data.messages);
  } catch (err) {
    console.error('State poll failed', err);
  }
}

function renderTopology(sessions) {
  const container = document.getElementById('nodes-list');
  if (sessions.length === 0) {
    container.innerHTML = '<div style="padding:16px;color:var(--text-muted);text-align:center;">No sessions active.</div>';
    return;
  }
  container.innerHTML = sessions.map(s => {
    const isHub = s.role === 'workhouse';
    const roleBadge = isHub ? '<span class="tag tag-white">HUB</span>' : '<span class="tag">WORKER</span>';
    return `
      <div class="node-item">
        <div class="node-top">
          <span class="node-name">${escapeHtml(s.name)}</span>
          ${roleBadge}
        </div>
        <div class="node-meta">
          <div>PID: ${s.pid} | PROJ: ${escapeHtml(s.project)} ${s.git_branch ? '[' + escapeHtml(s.git_branch) + ']' : ''}</div>
          <div style="font-size:10px;color:#71717a">${escapeHtml(s.cwd)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderTasks(tasks) {
  const container = document.getElementById('tasks-list');
  if (tasks.length === 0) {
    container.innerHTML = '<div style="padding:14px;color:var(--text-muted);text-align:center;">No tasks queued.</div>';
    return;
  }
  container.innerHTML = tasks.slice(0, 8).map(t => {
    const stBadge = t.status === 'completed'
      ? '<span class="tag tag-white">DONE</span>'
      : t.status === 'in_progress'
      ? '<span class="tag" style="border-color:#fff;color:#fff">ACTIVE</span>'
      : '<span class="tag">PENDING</span>';
    return `
      <div class="task-item">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
          <span class="task-title">${escapeHtml(t.title)}</span>
          ${stBadge}
        </div>
        <div class="task-meta">${escapeHtml(t.from_session_name)} &rarr; ${escapeHtml(t.to_session_id)}</div>
        ${t.result ? '<div style="color:#d4d4d8;margin-top:3px;font-size:10px;">&gt; ' + escapeHtml(t.result) + '</div>' : ''}
      </div>
    `;
  }).join('');
}

function renderLocks(locks) {
  const container = document.getElementById('locks-list');
  if (locks.length === 0) {
    container.innerHTML = '<div style="padding:10px 14px;color:var(--text-muted);font-size:11px;">Zero active mutex locks.</div>';
    return;
  }
  const now = Date.now();
  container.innerHTML = locks.map(l => {
    const rem = Math.max(0, Math.ceil((l.expires_at - now)/1000));
    return `
      <div style="padding:8px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;font-size:11px;">
        <div>
          <strong style="color:#fff">'${escapeHtml(l.name)}'</strong>
          <div style="color:var(--text-muted);font-size:10px;">Holder: ${escapeHtml(l.holder_name)}</div>
        </div>
        <span class="tag">${rem}s TTL</span>
      </div>
    `;
  }).join('');
}

function renderArtifacts(artifacts) {
  const tbody = document.getElementById('artifacts-body');
  if (artifacts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-muted);text-align:center;padding:20px;">No artifacts in depot.</td></tr>';
    return;
  }
  tbody.innerHTML = artifacts.map(a => `
    <tr>
      <td><strong style="color:#fff">${escapeHtml(a.name)}</strong></td>
      <td>${formatBytes(a.size_bytes)}</td>
      <td style="color:var(--text-muted)">${escapeHtml(a.sha256.slice(0, 12))}...</td>
      <td><span class="tag">${escapeHtml(a.owner_name)}</span></td>
      <td style="color:var(--text-mid)">${escapeHtml(a.description || '-')}</td>
      <td><a href="/api/artifacts/${encodeURIComponent(a.name)}" style="color:#fff;text-decoration:none;border-bottom:1px solid #fff;" download>GET</a></td>
    </tr>
  `).join('');
}

function renderComms(messages) {
  const container = document.getElementById('comms-feed');
  const filtered = messages.filter(m => {
    if (activeChannel === 'ALL') return true;
    return m.channel === activeChannel;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="padding:30px;color:var(--text-muted);text-align:center;">No communications on this frequency.</div>';
    return;
  }

  const shouldScroll = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;

  container.innerHTML = filtered.map(m => {
    const time = new Date(m.created_at).toLocaleTimeString();
    return `
      <div class="comm-row">
        <span class="comm-time">${time}</span>
        <span class="comm-chan">${escapeHtml(m.channel)}</span>
        <span class="comm-sender">&lt;${escapeHtml(m.sender_name)}&gt;</span>
        <span class="comm-body">${escapeHtml(m.content)}</span>
      </div>
    `;
  }).join('');

  if (shouldScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

async function sendMessage() {
  const input = document.getElementById('dispatch-input');
  const val = input.value.trim();
  if (!val) return;
  input.value = '';

  const chan = activeChannel === 'ALL' ? '#general' : activeChannel;
  try {
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: chan, message: val })
    });
    fetchState();
  } catch (err) {
    console.error('Failed to dispatch message', err);
  }
}

setInterval(fetchState, 1500);
fetchState();
