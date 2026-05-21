/**
 * AI Advisory Board UI client.
 *
 * Single-file vanilla JS app. Talks to the local Express server via REST
 * for read/write and WebSocket (ws://host:port/ws) for live discussion
 * progress. No build step — served directly by the server.
 */

import { rewriteWikiLinks, renderWikiBody, setKnowledgeState, refreshKnowledgeState } from './wikilinks.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

const state = {
  workspace: null,
  settings: null,
  members: [],
  principles: [],
  actionItems: [],
  discussions: [],
  currentDiscussion: null,
  /** Track in-flight typing bubbles per discussion-pending scope. */
  pendingTyping: new Map(), // memberName -> DOM element
  ws: null,
  route: 'discussions',
  followUpComposerOpen: false,
};

// Member colors mirror the agent file's `color:` field — we get them from
// the API. Fallback rotates through the known palette deterministically.
const FALLBACK_PALETTE = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red', 'orange', 'pink', 'purple'];
function colorForMember(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

// ------------------------------------------------------------------
// Bootstrap
// ------------------------------------------------------------------

async function bootstrap() {
  await refreshState({ silent: true });
  renderWorkspaceCard();
  connectWebSocket();
  setupNav();
  setupModal();
  setupEditModal();
  setupConfirmModal();
  setupExplorerModal();
  navigate('discussions');
}

async function refreshState(opts = {}) {
  try {
    const data = await fetchJSON('/api/state');
    Object.assign(state, {
      workspace: data.workspace,
      settings: data.settings,
      members: data.members || [],
      principles: data.principles || [],
      actionItems: data.actionItems || [],
      discussions: data.discussions || [],
    });
    if (data.workspace?.id) $('#workspace-label').textContent = data.workspace.id;
  } catch (e) {
    if (!opts.silent) toast('Failed to refresh state: ' + e.message, 'err');
    else toast('Failed to load workspace state: ' + e.message, 'err');
  }
}

function renderWorkspaceCard() {
  const card = $('#workspace-card');
  if (!card || !state.workspace) return;
  card.hidden = false;
  const activeCount = (state.members || []).filter((m) => m.isActive).length;
  $('#ws-scope-pill').textContent = state.workspace.scope === 'project' ? 'project' : 'home';
  $('#ws-scope-pill').className = 'ws-pill ' + (state.workspace.scope === 'project' ? 'project' : 'home');
  $('#ws-member-count').textContent = `${activeCount}/${state.members.length} active`;
  $('#ws-root-path').textContent = state.workspace.root || '';
  $('#ws-root-path').title = state.workspace.root || '';
}

function connectWebSocket() {
  const url = `ws://${location.host}/ws`;
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.addEventListener('open', () => setWsStatus('connected', 'ok'));
  ws.addEventListener('close', () => {
    setWsStatus('disconnected', 'err');
    setTimeout(connectWebSocket, 2000);
  });
  ws.addEventListener('error', () => setWsStatus('error', 'err'));
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleWsMessage(msg);
    } catch {
      /* ignore */
    }
  });
}

function setWsStatus(label, kind) {
  $('#ws-label').textContent = label;
  $('#ws-dot').className = 'status-dot ' + (kind || '');
}

// ------------------------------------------------------------------
// WebSocket handlers
// ------------------------------------------------------------------

function handleWsMessage(msg) {
  // Forward wiki events to the Knowledge view (decoupled via a custom event)
  if (typeof msg.type === 'string' && msg.type.startsWith('wiki_')) {
    window.dispatchEvent(new CustomEvent('aab-wiki-event', { detail: msg }));
    return;
  }
  if (msg.type === 'member_thinking') {
    addTypingBubble(msg.memberName);
  } else if (msg.type === 'member_activity') {
    updateTypingActivity(msg.memberName, msg.activity, msg.detail);
  } else if (msg.type === 'member_response') {
    // The server includes the name at top-level too for symmetry, but the
    // canonical source is `msg.response.memberName`.
    const name = msg.memberName || msg.response?.memberName;
    replaceTypingWithResponse(name, msg.response);
  } else if (msg.type === 'orchestrator_thinking') {
    // Optional: show a system "Orchestrator analyzing..." line
    addSystemLine('Orchestrator analyzing the round…');
  } else if (msg.type === 'orchestrator_decision') {
    addOrchestratorDecision(msg.decision);
  } else if (msg.type === 'discussion_gated') {
    // Pre-round gate fired — no members actually spawned. Clear any
    // optimistic typing bubbles so they don't sit forever.
    state.pendingTyping.forEach((b) => b.remove());
    state.pendingTyping.clear();
    state.currentDiscussion = msg.discussion;
    updateDiscussionList(msg.discussion);
    finalizeChat(msg, { gated: true });
  } else if (msg.type === 'discussion_completed') {
    state.currentDiscussion = msg.discussion;
    updateDiscussionList(msg.discussion);
    finalizeChat(msg);
  } else if (msg.type === 'error') {
    toast(msg.message, 'err');
    // Re-enable any disabled action buttons so the user can retry
    setActionButtonsBusy(false);
  } else if (
    msg.type === 'member_enhance_started' ||
    msg.type === 'member_enhance_progress' ||
    msg.type === 'member_enhance_done' ||
    msg.type === 'member_enhance_failed' ||
    msg.type === 'member_voice_started' ||
    msg.type === 'member_voice_done' ||
    msg.type === 'member_voice_preview' ||
    msg.type === 'members_sync_done' ||
    msg.type === 'principles_seeded' ||
    msg.type === 'principle_explorer_thinking' ||
    msg.type === 'principle_explorer_reply'
  ) {
    window.dispatchEvent(new CustomEvent('aab-member-event', { detail: msg }));
  } else if (msg.type && msg.type.startsWith('coach_')) {
    window.dispatchEvent(new CustomEvent('aab-coach-event', { detail: msg }));
  } else if (msg.type && msg.type.startsWith('sparring_')) {
    window.dispatchEvent(new CustomEvent('aab-sparring-event', { detail: msg }));
  } else if (
    msg.type === 'action_created' ||
    msg.type === 'action_updated' ||
    msg.type === 'action_deleted' ||
    msg.type === 'actions_extracted'
  ) {
    // Light refresh: pull the latest state and, when we're on the Actions
    // route, re-render the kanban. Avoids a heavy diff loop and keeps the
    // server as the source of truth.
    refreshState({ silent: true }).then(() => {
      if (state.route === 'actions') navigate('actions');
    });
  } else if (
    typeof msg.type === 'string' &&
    (msg.type.startsWith('planner_') || msg.type.startsWith('skill_run_'))
  ) {
    // Phase 5 — Skill Planner + skill-creator orchestration events.
    window.dispatchEvent(new CustomEvent('aab-planner-event', { detail: msg }));
  }
}

// ------------------------------------------------------------------
// Navigation
// ------------------------------------------------------------------

function setupNav() {
  $$('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.route));
  });
}

function navigate(route) {
  state.route = route;
  $$('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.route === route));
  const main = $('#main');
  main.innerHTML = '';
  if (route === 'discussions') renderDiscussionsView(main);
  else if (route === 'members') renderMembersView(main);
  else if (route === 'actions') renderActionsView(main);
  else if (route === 'principles') renderPrinciplesView(main);
  else if (route === 'knowledge') renderKnowledgeView(main);
  else if (route === 'coach') renderCoachView(main);
  else if (route === 'skills') renderSkillsView(main);
  else if (route === 'settings') renderSettingsView(main);
}

// ------------------------------------------------------------------
// Discussions list view
// ------------------------------------------------------------------

function renderDiscussionsView(main) {
  const view = h('div', { class: 'view' });

  const header = h('div', { class: 'view-header' });
  header.appendChild(
    h('div', {}, [
      h('div', { class: 'view-title' }, 'Discussions'),
      h('div', { class: 'view-subtitle' }, `${state.discussions.length} saved`),
    ]),
  );
  const newBtn = h('button', { class: 'btn-primary' }, '+ New discussion');
  newBtn.addEventListener('click', openNewDiscussionModal);
  header.appendChild(newBtn);
  view.appendChild(header);

  const body = h('div', { class: 'view-body' });

  if (state.discussions.length === 0) {
    body.appendChild(emptyState('💬', 'No discussions yet', 'Click "New discussion" to convene the board.'));
  } else {
    const list = h('div', { class: 'discussion-list' });
    state.discussions.forEach((d) => list.appendChild(renderDiscussionCard(d)));
    body.appendChild(list);
  }

  view.appendChild(body);
  main.appendChild(view);
}

function renderDiscussionCard(d) {
  const card = h('div', { class: 'discussion-card' });
  card.appendChild(h('div', { class: 'discussion-card-q' }, d.question));

  const status = d.completedAt ? 'done' : d.pendingUserRequest ? 'awaiting' : 'open';
  const statusLabel = status === 'done' ? 'concluded' : status === 'awaiting' ? 'awaiting input' : 'open';

  const meta = h('div', { class: 'discussion-card-meta' });
  meta.appendChild(h('span', { class: `status-pill ${status}` }, statusLabel));
  meta.appendChild(h('span', {}, `${d.rounds.length} round${d.rounds.length === 1 ? '' : 's'}`));
  meta.appendChild(h('span', {}, `${d.totalTurns} turn${d.totalTurns === 1 ? '' : 's'}`));
  meta.appendChild(h('span', {}, formatRelative(d.createdAt)));
  card.appendChild(meta);

  card.addEventListener('click', () => openChatView(d));
  return card;
}

// ------------------------------------------------------------------
// Chat view
// ------------------------------------------------------------------

function openChatView(discussion) {
  state.currentDiscussion = discussion;
  state.pendingTyping.clear();
  state.followUpComposerOpen = false;
  const main = $('#main');
  main.innerHTML = '';

  const view = h('div', { class: 'view chat-view' });

  // Header
  const header = h('div', { class: 'view-header' });
  const back = h('button', { class: 'btn-secondary' }, '← Back');
  back.addEventListener('click', () => navigate('discussions'));
  header.appendChild(back);
  header.appendChild(h('div', { class: 'chat-header-q' }, discussion.question));
  const headerActions = h('div', { class: 'chat-header-actions' });
  const sparListBtn = h(
    'button',
    {
      class: 'btn-secondary',
      type: 'button',
      'data-testid': 'sparring-sessions-btn',
      title: 'Open the sparring sessions list for this discussion',
    },
    '⚔ Sparring',
  );
  sparListBtn.addEventListener('click', () => openSparringListModal(discussion));
  headerActions.appendChild(sparListBtn);
  header.appendChild(headerActions);
  view.appendChild(header);

  // Stream
  const stream = h('div', { class: 'chat-stream', id: 'chat-stream' });
  for (const node of discussionTimeline(discussion)) stream.appendChild(node);
  if (discussion.pendingUserRequest) {
    stream.appendChild(pendingRequestBubble(discussion.pendingUserRequest));
  }
  view.appendChild(stream);

  // Action footer (continue / respond)
  view.appendChild(renderChatFooter(discussion));

  main.appendChild(view);
  scrollChat();
}

// Walk a saved discussion and return DOM nodes in chat-app order:
// - the user's initial question
// - per round: round divider, any user reply that triggered the round,
//   each member response, then the orchestrator decision
function discussionTimeline(discussion) {
  const nodes = [];
  const userResponses = discussion.userResponses || [];

  const initial = userResponses.find((u) => u.type === 'initial_question');
  if (initial) nodes.push(userBubble(initial.content, 'Question'));
  else if (discussion.question) nodes.push(userBubble(discussion.question, 'Question'));

  for (const round of discussion.rounds || []) {
    nodes.push(roundDivider(round.roundNumber));

    // HITL reply that triggered THIS round was attached with
    // roundNumber = previous round's number.
    const hitlReply = userResponses.find(
      (u) => u.type === 'advisory_board_requested' && u.roundNumber === round.roundNumber - 1,
    );
    if (hitlReply && round.roundNumber > 1) {
      nodes.push(userBubble(hitlReply.content, 'Your reply', hitlReply.selectedOption));
    }

    if (round.userResponse && round.userResponse.type === 'follow_up_question') {
      const target =
        round.followUpTargetType === 'specific'
          ? '· targeted'
          : round.followUpTargetType === 'subset'
            ? '· subset'
            : '';
      nodes.push(userBubble(round.userResponse.content, `Follow-up ${target}`.trim()));
    }

    for (const r of round.responses) nodes.push(messageBubble(r));
    if (round.orchestratorDecision) nodes.push(orchestratorBubble(round.orchestratorDecision));

    // Sparring injections attached to THIS round (anywhere in userResponses
    // whose roundNumber matches and type === 'sparring_injection').
    const injections = userResponses.filter(
      (u) => u.type === 'sparring_injection' && u.roundNumber === round.roundNumber,
    );
    for (const inj of injections) {
      const member = state.members.find((m) => m.id === inj.selectedMemberId);
      const memberLabel = member?.name || 'Board member';
      nodes.push(userBubble(inj.content, `Sparring insight injected (via ${memberLabel})`));
    }
  }
  return nodes;
}

function renderChatFooter(discussion) {
  const footer = h('div', { class: 'chat-footer', id: 'chat-footer' });
  if (discussion.completedAt) {
    const row = h('div', { class: 'chat-actions' });
    row.appendChild(h('div', { class: 'message-meta' }, '✓ Discussion concluded.'));
    const extractBtn = h(
      'button',
      {
        class: 'btn-secondary',
        type: 'button',
        'data-testid': 'extract-actions-btn',
        title: 'Auto-extract action items from this concluded discussion',
      },
      '📋 Extract actions',
    );
    extractBtn.addEventListener('click', () => openExtractActionsModal(discussion));
    row.appendChild(extractBtn);
    footer.appendChild(row);
    return footer;
  }
  if (discussion.pendingUserRequest) {
    footer.appendChild(renderRespondForm(discussion));
    return footer;
  }
  // Open discussion → Continue + Follow up buttons (or active follow-up composer)
  if (state.followUpComposerOpen) {
    footer.appendChild(renderFollowUpComposer(discussion));
    return footer;
  }
  const row = h('div', { class: 'chat-actions' });
  const cont = h('button', { class: 'btn-primary', id: 'btn-continue' }, '▸ Continue discussion');
  cont.addEventListener('click', () => triggerContinue(discussion));
  row.appendChild(cont);
  const followBtn = h('button', { class: 'btn-secondary', id: 'btn-follow-up' }, '↳ Follow up');
  followBtn.addEventListener('click', () => {
    state.followUpComposerOpen = true;
    refreshChatFooter(discussion);
  });
  row.appendChild(followBtn);
  footer.appendChild(row);

  const turnsLeft = (discussion.maxTurns ?? 0) - (discussion.totalTurns ?? 0);
  footer.appendChild(
    h(
      'div',
      { class: 'message-meta', style: 'margin-top:6px' },
      `${discussion.totalTurns}/${discussion.maxTurns} turns used · ${turnsLeft} left`,
    ),
  );
  return footer;
}

function renderFollowUpComposer(discussion) {
  const wrap = h('div', { class: 'respond-form follow-up-form' });
  wrap.appendChild(h('div', { class: 'struct-section-title' }, 'Follow-up question'));

  const textarea = h('textarea', {
    id: 'follow-up-input',
    rows: '3',
    placeholder: 'Ask the board a sharper question, or push back on a specific point…',
  });
  wrap.appendChild(textarea);

  // Member selector — defaults to all of the discussion's members selected.
  const allowedIds = new Set(discussion.selectedMemberIds ?? state.members.map((m) => m.id));
  const candidates = state.members.filter((m) => allowedIds.has(m.id) && m.isActive);
  const selectedSet = new Set(candidates.map((m) => m.id));

  wrap.appendChild(
    h('div', { class: 'message-meta', style: 'margin-top:4px' }, 'Who should answer? (deselect to narrow)'),
  );
  const chips = h('div', { class: 'respond-options follow-up-chips' });
  candidates.forEach((m) => {
    const chip = h('button', { class: 'chip selected', type: 'button', 'data-member-id': m.id });
    chip.appendChild(h('div', { class: 'avatar', 'data-color': m.color || colorForMember(m.name) }, m.initials || initialsOf(m.name)));
    chip.appendChild(h('span', {}, m.name));
    chip.addEventListener('click', () => {
      if (selectedSet.has(m.id)) {
        selectedSet.delete(m.id);
        chip.classList.remove('selected');
      } else {
        selectedSet.add(m.id);
        chip.classList.add('selected');
      }
    });
    chips.appendChild(chip);
  });
  wrap.appendChild(chips);

  const actions = h('div', { class: 'chat-actions', style: 'justify-content:flex-end;width:100%' });
  const cancel = h('button', { class: 'btn-secondary' }, 'Cancel');
  cancel.addEventListener('click', () => {
    state.followUpComposerOpen = false;
    refreshChatFooter(discussion);
  });
  actions.appendChild(cancel);

  const submit = h('button', { class: 'btn-primary', id: 'btn-follow-up-submit' }, '↳ Send follow-up');
  submit.addEventListener('click', () => {
    const question = textarea.value.trim();
    if (!question) {
      toast('Type a follow-up question first.', 'err');
      return;
    }
    if (selectedSet.size === 0) {
      toast('Pick at least one member to answer.', 'err');
      return;
    }
    let targetType = 'all';
    let payload = { question };
    if (selectedSet.size === candidates.length) {
      targetType = 'all';
    } else if (selectedSet.size === 1) {
      targetType = 'specific';
      payload.selectedMemberId = [...selectedSet][0];
    } else {
      targetType = 'subset';
      payload.selectedMemberIds = [...selectedSet];
    }
    payload.targetType = targetType;
    triggerFollowUp(discussion, payload);
  });
  actions.appendChild(submit);
  wrap.appendChild(actions);

  return wrap;
}

async function triggerFollowUp(discussion, payload) {
  setActionButtonsBusy(true);
  state.followUpComposerOpen = false;
  try {
    // Show the user's follow-up as a bubble + a fresh round divider
    const targetLabel =
      payload.targetType === 'specific'
        ? 'Follow-up · targeted'
        : payload.targetType === 'subset'
          ? 'Follow-up · subset'
          : 'Follow-up';
    appendToStream(userBubble(payload.question, targetLabel));
    const nextRound = (discussion.rounds[discussion.rounds.length - 1]?.roundNumber ?? 0) + 1;
    appendToStream(roundDivider(nextRound));
    await fetchJSON(`/api/discussions/${discussion.id}/follow-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    toast('Follow-up dispatched — board is responding…', 'ok');
    // Replace the composer footer with a busy footer until WS lands the result
    const footer = $('#chat-footer');
    if (footer) {
      footer.replaceWith(h('div', { class: 'chat-footer', id: 'chat-footer' }, h('div', { class: 'message-meta' }, '… orchestrator deciding')));
    }
  } catch (e) {
    toast('Follow-up failed: ' + e.message, 'err');
    setActionButtonsBusy(false);
    state.followUpComposerOpen = true;
    refreshChatFooter(discussion);
  }
}

function appendToStream(node) {
  const stream = $('#chat-stream');
  if (stream) {
    stream.appendChild(node);
    scrollChat();
  }
}

function renderRespondForm(discussion) {
  const req = discussion.pendingUserRequest;
  const wrap = h('div', { class: 'respond-form' });

  wrap.appendChild(h('div', { class: 'struct-section-title' }, 'Your reply'));

  let selectedOption = null;
  if (req.options?.length) {
    const opts = h('div', { class: 'respond-options' });
    req.options.forEach((opt, idx) => {
      const chip = h('button', { class: 'chip respond-option', type: 'button' }, `${idx + 1}. ${opt}`);
      chip.addEventListener('click', () => {
        selectedOption = opt;
        $$('.respond-option', opts).forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
      });
      opts.appendChild(chip);
    });
    wrap.appendChild(opts);
  }

  const textarea = h('textarea', {
    id: 'respond-input',
    rows: '3',
    placeholder: req.options?.length
      ? 'Pick an option above and/or write your answer…'
      : 'Type your answer to the board…',
  });
  wrap.appendChild(textarea);

  const submit = h('button', { class: 'btn-primary', id: 'btn-respond' }, '↳ Send reply');
  submit.addEventListener('click', () => {
    const content = textarea.value.trim();
    if (!content && !selectedOption) {
      toast('Type a reply or pick an option first.', 'err');
      return;
    }
    const finalContent = content || selectedOption || '';
    triggerRespond(discussion, finalContent, selectedOption);
  });
  wrap.appendChild(submit);
  return wrap;
}

async function triggerContinue(discussion) {
  setActionButtonsBusy(true);
  try {
    addSystemLine('Continuing the discussion…');
    await fetchJSON(`/api/discussions/${discussion.id}/continue`, { method: 'POST' });
    toast('Continuing — orchestrator deciding…', 'ok');
  } catch (e) {
    toast('Continue failed: ' + e.message, 'err');
    setActionButtonsBusy(false);
  }
}

async function triggerRespond(discussion, content, selectedOption) {
  setActionButtonsBusy(true);
  try {
    // Show the user's reply as a bubble immediately, plus a fresh round divider
    appendToStream(userBubble(content, 'Your reply', selectedOption));
    const nextRound = (discussion.rounds[discussion.rounds.length - 1]?.roundNumber ?? 0) + 1;
    appendToStream(roundDivider(nextRound));
    await fetchJSON(`/api/discussions/${discussion.id}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, selectedOption: selectedOption || undefined }),
    });
    toast('Reply sent — board is responding…', 'ok');
  } catch (e) {
    toast('Reply failed: ' + e.message, 'err');
    setActionButtonsBusy(false);
  }
}

function setActionButtonsBusy(busy) {
  const btns = [$('#btn-continue'), $('#btn-respond')].filter(Boolean);
  for (const b of btns) {
    b.disabled = busy;
    if (busy && b.id === 'btn-continue') b.textContent = '… working';
    if (busy && b.id === 'btn-respond') b.textContent = '… sending';
  }
}

function truncatePreview(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function startNewChatView(question, members) {
  state.pendingTyping.clear();
  const main = $('#main');
  main.innerHTML = '';
  const view = h('div', { class: 'view chat-view' });

  const header = h('div', { class: 'view-header' });
  const back = h('button', { class: 'btn-secondary' }, '← Back');
  back.addEventListener('click', () => navigate('discussions'));
  header.appendChild(back);
  header.appendChild(h('div', { class: 'chat-header-q' }, question));
  header.appendChild(h('div', {}, ''));
  view.appendChild(header);

  const stream = h('div', { class: 'chat-stream', id: 'chat-stream' });
  // User's question as the first bubble — like sending a message in a chat app
  stream.appendChild(userBubble(question, 'Question'));
  stream.appendChild(roundDivider(1));
  view.appendChild(stream);

  // Placeholder footer — will be replaced by refreshChatFooter() when the
  // discussion lands via WS `discussion_completed` or `discussion_gated`.
  view.appendChild(h('div', { class: 'chat-footer', id: 'chat-footer' }));

  main.appendChild(view);
}

// User message bubble — right-aligned, like sent messages in iMessage/WhatsApp.
function userBubble(text, label, selectedOption) {
  const wrap = h('div', { class: 'message message-user' });

  const body = h('div', { class: 'message-body user-body' });
  const name = h('div', { class: 'message-name' }, label || 'You');
  body.appendChild(name);

  const bubble = h('div', { class: 'bubble user-bubble' }, text);
  body.appendChild(bubble);

  if (selectedOption) {
    body.appendChild(h('div', { class: 'message-meta', style: 'margin-top:4px' }, `↳ chose: ${selectedOption}`));
  }

  wrap.appendChild(body);
  // Avatar on the right (mirrored from member layout)
  wrap.appendChild(h('div', { class: 'avatar avatar-user', 'data-color': 'brand' }, '👤'));
  return wrap;
}

function roundDivider(n) {
  return h('div', { class: 'round-divider' }, `Round ${n}`);
}

function messageBubble(r) {
  const member = state.members.find((m) => m.id === r.memberId) || { name: r.memberName };
  const color = member.color || colorForMember(r.memberName);
  const initials = member.initials || initialsOf(r.memberName);

  const wrap = h('div', {
    class: 'message',
    'data-testid': 'response-card',
    'data-member-id': r.memberId || '',
    'data-round': r.roundNumber || '',
    'data-turn': r.turnNumber || '',
  });
  wrap.appendChild(h('div', { class: 'avatar', 'data-color': color }, initials));

  const body = h('div', { class: 'message-body' });
  const nameRow = h('div', { class: 'message-name-row' });
  const name = h('div', { class: 'message-name' }, r.memberName);
  if (r.turnNumber) {
    name.appendChild(h('span', { class: 'message-meta' }, `turn ${r.turnNumber}`));
  }
  nameRow.appendChild(name);

  if (r.memberId && state.currentDiscussion) {
    const sparBtn = h(
      'button',
      {
        class: 'btn-ghost btn-spar',
        type: 'button',
        title: `Open 1:1 deep dive with ${r.memberName}`,
        'data-testid': 'spar-btn',
        'data-member-id': r.memberId,
        'data-round': r.roundNumber || '',
        'data-turn': r.turnNumber || '',
      },
      '⚔ Spar',
    );
    sparBtn.addEventListener('click', () =>
      openSparringPanel({
        discussion: state.currentDiscussion,
        memberId: r.memberId,
        memberName: r.memberName,
        anchorRoundNumber: r.roundNumber,
        anchorTurnNumber: r.turnNumber,
      }),
    );
    nameRow.appendChild(sparBtn);
  }
  body.appendChild(nameRow);

  const bubble = h('div', { class: 'bubble' }, r.content);
  body.appendChild(bubble);

  // Structured details
  const sd = r.structuredData;
  if (sd && (sd.keyPoints?.length || sd.questionsForOthers?.length || sd.actionSteps?.length || sd.confidence != null)) {
    const struct = h('div', { class: 'struct' });
    if (sd.keyPoints?.length) struct.appendChild(structSection('Key points', sd.keyPoints, '•'));
    if (sd.questionsForOthers?.length) struct.appendChild(structSection('Questions for others', sd.questionsForOthers, '?'));
    if (sd.actionSteps?.length) struct.appendChild(structSection('Action steps', sd.actionSteps, '→'));
    if (typeof sd.confidence === 'number') {
      const row = h('div', { class: 'confidence-row' });
      row.appendChild(h('span', {}, `Confidence ${sd.confidence}%`));
      const bar = h('div', { class: 'confidence-bar' });
      bar.appendChild(h('div', { class: 'confidence-bar-fill', style: `width: ${sd.confidence}%` }));
      row.appendChild(bar);
      struct.appendChild(row);
    }
    body.appendChild(struct);
  }

  wrap.appendChild(body);
  return wrap;
}

function structSection(title, items, marker) {
  const sec = h('div', { class: 'struct-section' });
  sec.appendChild(h('div', { class: 'struct-section-title' }, title));
  const ul = h('ul');
  items.forEach((it) => ul.appendChild(h('li', {}, `${marker ? marker + ' ' : ''}${it}`)));
  sec.appendChild(ul);
  return sec;
}

function typingBubble(memberName) {
  const member = state.members.find((m) => m.name === memberName) || { name: memberName };
  const color = member.color || colorForMember(memberName);
  const initials = member.initials || initialsOf(memberName);

  const wrap = h('div', { class: 'message', 'data-typing-for': memberName });
  wrap.appendChild(h('div', { class: 'avatar', 'data-color': color }, initials));

  const body = h('div', { class: 'message-body' });
  body.appendChild(h('div', { class: 'message-name' }, memberName));

  // Inline activity label + animated dots — both inside the bubble shape so
  // the shape doesn't shift when the label changes.
  const bubble = h('div', { class: 'typing-bubble' });
  const activityLabel = h(
    'span',
    { class: 'typing-activity', 'data-activity-for': memberName },
    'thinking',
  );
  bubble.appendChild(activityLabel);
  const dots = h('div', { class: 'typing' });
  dots.appendChild(h('span'));
  dots.appendChild(h('span'));
  dots.appendChild(h('span'));
  bubble.appendChild(dots);
  body.appendChild(bubble);

  // Optional secondary line (e.g. the search query, the file path)
  body.appendChild(h('div', { class: 'typing-detail', 'data-detail-for': memberName }));

  wrap.appendChild(body);
  return wrap;
}

function updateTypingActivity(memberName, activity, detail) {
  const label = document.querySelector(`[data-activity-for="${cssEscape(memberName)}"]`);
  if (label) label.textContent = (activity || 'thinking').replace(/[.…]+$/, '');
  const detailEl = document.querySelector(`[data-detail-for="${cssEscape(memberName)}"]`);
  if (detailEl) {
    if (detail) {
      const truncated = String(detail).length > 80 ? String(detail).slice(0, 80) + '…' : String(detail);
      detailEl.textContent = truncated;
      detailEl.style.display = 'block';
    } else {
      detailEl.textContent = '';
      detailEl.style.display = 'none';
    }
  }
}

function cssEscape(s) {
  // Minimal CSS attribute-value escape for double-quote selectors.
  return String(s).replace(/(["\\])/g, '\\$1');
}

function orchestratorBubble(decision) {
  const text = decisionLabel(decision);
  return h('div', { class: 'message' }, [
    h('div', { class: 'avatar', 'data-color': 'purple' }, '⚙'),
    h('div', { class: 'message-body' }, [
      h('div', { class: 'message-name' }, ['Orchestrator', h('span', { class: 'message-meta' }, `confidence ${decision.confidence ?? '–'}%`)]),
      h('div', { class: 'system-bubble' }, text),
    ]),
  ]);
}

function pendingRequestBubble(req) {
  const lines = [
    h('div', { class: 'message-name' }, '⚠ The board is asking you a question'),
    h('div', { class: 'bubble' }, [
      h('strong', {}, req.question),
      ...(req.context ? [h('div', { class: 'message-meta', style: 'display:block;margin-top:6px' }, req.context)] : []),
      ...(req.options?.length
        ? [
            h('div', { style: 'margin-top: 10px' }, [
              h('div', { class: 'struct-section-title' }, 'Options'),
              h(
                'ol',
                { style: 'padding-left: 22px; margin: 0' },
                req.options.map((o) => h('li', {}, o)),
              ),
            ]),
          ]
        : []),
    ]),
  ];
  return h('div', { class: 'message' }, [h('div', { class: 'avatar', 'data-color': 'yellow' }, '!'), h('div', { class: 'message-body' }, lines)]);
}

function decisionLabel(d) {
  const action = (d.action || 'continue').toUpperCase();
  return `${action}${d.reasoning ? ' — ' + d.reasoning : ''}`;
}

function addTypingBubble(memberName) {
  const stream = $('#chat-stream');
  if (!stream) return;
  const existing = state.pendingTyping.get(memberName);
  if (existing) return; // already showing
  const bubble = typingBubble(memberName);
  stream.appendChild(bubble);
  state.pendingTyping.set(memberName, bubble);
  scrollChat();
}

function replaceTypingWithResponse(memberName, response) {
  const stream = $('#chat-stream');
  if (!stream) return;
  // Primary: state.pendingTyping (Map keyed by name). Fallback: DOM search
  // by data-typing-for attribute (in case the Map ever drifts out of sync —
  // belt and suspenders).
  let typing = memberName ? state.pendingTyping.get(memberName) : null;
  if (!typing && memberName) {
    typing = stream.querySelector(`[data-typing-for="${cssEscape(memberName)}"]`);
  }
  const bubble = messageBubble(response);
  if (typing) {
    typing.replaceWith(bubble);
    if (memberName) state.pendingTyping.delete(memberName);
  } else {
    stream.appendChild(bubble);
  }
  scrollChat();
}

function addSystemLine(text) {
  const stream = $('#chat-stream');
  if (!stream) return;
  stream.appendChild(
    h('div', { class: 'message' }, [
      h('div', { class: 'avatar', 'data-color': 'purple' }, '⚙'),
      h('div', { class: 'message-body' }, [h('div', { class: 'system-bubble' }, text)]),
    ]),
  );
  scrollChat();
}

function addOrchestratorDecision(decision) {
  const stream = $('#chat-stream');
  if (!stream) return;
  // Remove the "analyzing" system line if present
  const lastSys = $$('.system-bubble', stream).pop();
  if (lastSys && lastSys.textContent.includes('analyzing')) {
    lastSys.closest('.message')?.remove();
  }
  stream.appendChild(orchestratorBubble(decision));
  scrollChat();
}

function finalizeChat(msg, opts = {}) {
  // Any typing bubbles that never got a matching member_response (e.g., a
  // member failed silently) become orphans — clear them so the user isn't
  // staring at perpetually-thinking dots.
  state.pendingTyping.forEach((bubble, name) => {
    bubble.replaceWith(
      h('div', { class: 'message' }, [
        h('div', { class: 'avatar', 'data-color': 'red' }, '✗'),
        h('div', { class: 'message-body' }, [
          h('div', { class: 'message-name' }, name),
          h('div', { class: 'system-bubble' }, 'No response — this member failed or timed out.'),
        ]),
      ]),
    );
  });
  state.pendingTyping.clear();

  // Re-fetch the bootstrap state so the discussion list refreshes
  fetchJSON('/api/state').then((data) => {
    state.discussions = data.discussions;
  });
  const stream = $('#chat-stream');
  if (stream && !opts.gated) {
    const cost = msg.costUsd != null ? `$${Number(msg.costUsd).toFixed(4)}` : '$0.00';
    const dur = msg.durationMs ? formatDuration(msg.durationMs) : '';
    stream.appendChild(
      h(
        'div',
        { class: 'message' },
        [
          h('div', { class: 'avatar', 'data-color': 'green' }, '✓'),
          h('div', { class: 'message-body' }, [h('div', { class: 'system-bubble' }, `Round saved · ${dur} · ${cost}`)]),
        ],
      ),
    );
    scrollChat();
  }
  if (msg.discussion?.pendingUserRequest && stream) {
    stream.appendChild(pendingRequestBubble(msg.discussion.pendingUserRequest));
    scrollChat();
  }
  // Refresh the action footer so Continue / Respond / concluded state matches
  // the current discussion — the engine may have just changed any of them.
  if (msg.discussion) {
    refreshChatFooter(msg.discussion);
  }
  setActionButtonsBusy(false);
}

function refreshChatFooter(discussion) {
  const oldFooter = $('#chat-footer');
  if (!oldFooter) return;
  oldFooter.replaceWith(renderChatFooter(discussion));
}

function scrollChat() {
  requestAnimationFrame(() => {
    const stream = $('#chat-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  });
}

function updateDiscussionList(discussion) {
  const idx = state.discussions.findIndex((d) => d.id === discussion.id);
  if (idx >= 0) state.discussions[idx] = discussion;
  else state.discussions.unshift(discussion);
}

// ------------------------------------------------------------------
// New-discussion modal
// ------------------------------------------------------------------

function setupModal() {
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-submit').addEventListener('click', submitNewDiscussion);
}

async function openNewDiscussionModal() {
  // Always refresh members from server first — protects against stale state
  // if the user just edited members in another tab.
  await refreshState({ silent: true });
  renderWorkspaceCard();

  const modal = $('#new-discussion-modal');
  modal.hidden = false;
  $('#new-question').value = '';

  const chips = $('#member-chips');
  chips.innerHTML = '';
  const submit = $('#modal-submit');
  const active = (state.members || []).filter((m) => m.isActive);

  if (active.length === 0) {
    submit.disabled = true;
    const wsRoot = state.workspace?.root || '<unknown>';
    const wsId = state.workspace?.id || '<unknown>';
    chips.appendChild(
      h('div', { class: 'modal-empty' }, [
        h('div', { class: 'modal-empty-title' }, '⚠ No active members in this workspace'),
        h('div', { class: 'modal-empty-meta' }, `Workspace: ${wsId}`),
        h('div', { class: 'modal-empty-meta', style: 'font-family: var(--font-mono); font-size:11px' }, wsRoot),
        h('div', { class: 'modal-empty-meta', style: 'margin-top:8px' },
          'Either this is the wrong workspace, or no members were seeded. Click "Board members" in the sidebar to add one, or run `aab init` from this directory.'),
      ]),
    );
    $('#new-question').focus();
    return;
  }

  submit.disabled = false;
  for (const m of active) {
    const chip = h('div', { class: 'chip selected', 'data-member-id': m.id });
    chip.appendChild(h('div', { class: 'avatar', 'data-color': m.color || colorForMember(m.name) }, m.initials || initialsOf(m.name)));
    chip.appendChild(h('span', {}, m.name));
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
    chips.appendChild(chip);
  }
  $('#new-question').focus();
}

function closeModal() {
  $('#new-discussion-modal').hidden = true;
}

async function submitNewDiscussion() {
  const question = $('#new-question').value.trim();
  if (!question) {
    toast('Please enter a question.', 'err');
    return;
  }
  const memberIds = $$('#member-chips .chip.selected').map((c) => c.dataset.memberId);
  if (memberIds.length === 0) {
    toast('Select at least one member.', 'err');
    return;
  }

  const submit = $('#modal-submit');
  submit.disabled = true;
  submit.textContent = 'Starting…';

  // Open the chat view BEFORE the request so #chat-stream exists by the time
  // any `member_thinking` events arrive over WS. Pre-create the typing
  // bubbles too so the user sees activity immediately, not a blank stream.
  closeModal();
  const selectedMembers = state.members.filter((m) => memberIds.includes(m.id));
  startNewChatView(question, selectedMembers);
  for (const m of selectedMembers) addTypingBubble(m.name);

  try {
    await fetchJSON('/api/discussions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, memberIds }),
    });
    toast('Discussion started — members are thinking…', 'ok');
  } catch (e) {
    toast('Failed to start: ' + e.message, 'err');
    // Server rejected — clear the optimistic typing bubbles
    state.pendingTyping.forEach((b) => b.remove());
    state.pendingTyping.clear();
    appendToStream(
      h('div', { class: 'message' }, [
        h('div', { class: 'avatar', 'data-color': 'red' }, '✗'),
        h('div', { class: 'message-body' }, [
          h('div', { class: 'system-bubble' }, 'Could not start the discussion: ' + e.message),
        ]),
      ]),
    );
  } finally {
    submit.disabled = false;
    submit.textContent = 'Start discussion';
  }
}

// ------------------------------------------------------------------
// Members view
// ------------------------------------------------------------------

function renderMembersView(main) {
  const view = h('div', { class: 'view' });
  const activeCount = state.members.filter((m) => m.isActive).length;
  const header = h('div', { class: 'view-header' }, [
    h('div', {}, [
      h('div', { class: 'view-title' }, 'Board members'),
      h('div', { class: 'view-subtitle' }, `${activeCount} active · ${state.members.length} total`),
    ]),
  ]);
  const headerActions = h('div', { class: 'header-actions' });
  const syncBtn = h('button', { class: 'btn-secondary', 'data-testid': 'members-sync-btn', title: 'Regenerate all .claude/agents/<slug>.md files' }, '↻ Regenerate agent files');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    const prev = syncBtn.textContent;
    syncBtn.textContent = 'Regenerating…';
    try {
      const r = await fetchJSON('/api/members/sync-agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: false }),
      });
      toast(`Wrote ${r.written}/${r.total} agent files (${r.skipped} skipped).`, 'ok');
    } catch (e) {
      toast('Sync failed: ' + e.message, 'err');
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = prev;
    }
  });
  const addBtn = h('button', { class: 'btn-primary', 'data-testid': 'members-add-btn' }, '+ Add member');
  addBtn.addEventListener('click', () => openMemberEditModal(null));
  headerActions.appendChild(syncBtn);
  headerActions.appendChild(addBtn);
  header.appendChild(headerActions);
  view.appendChild(header);

  const body = h('div', { class: 'view-body' });
  if (state.members.length === 0) {
    const empty = emptyState(
      '👥',
      'No members in this workspace',
      `Add one now, or run \`aab init\` to seed Elon, Julian, and Alexandra.`,
    );
    const seedBtn = h('button', { class: 'btn-primary', style: 'margin-top:12px' }, '+ Add a member');
    seedBtn.addEventListener('click', () => openMemberEditModal(null));
    empty.appendChild(seedBtn);
    body.appendChild(empty);
  } else {
    const grid = h('div', { class: 'members-grid' });
    for (const m of state.members) grid.appendChild(memberCard(m));
    body.appendChild(grid);
  }
  view.appendChild(body);
  main.appendChild(view);
}

function memberCard(m) {
  const card = h('div', { class: 'member-card' + (m.isActive ? '' : ' is-inactive') });

  const head = h('div', { class: 'member-card-head' });
  head.appendChild(h('div', { class: 'avatar', 'data-color': m.color || colorForMember(m.name) }, m.initials || initialsOf(m.name)));
  head.appendChild(
    h('div', { class: 'member-card-headtext' }, [
      h('div', { class: 'member-card-name' }, m.name),
      h('div', { class: 'member-card-title' }, m.title),
    ]),
  );
  // Active toggle (top-right of card)
  const toggle = h(
    'label',
    { class: 'switch', title: m.isActive ? 'Deactivate' : 'Activate' },
    [
      h('input', { type: 'checkbox' }),
      h('span', { class: 'switch-track' }),
    ],
  );
  const checkbox = toggle.querySelector('input');
  checkbox.checked = !!m.isActive;
  checkbox.addEventListener('change', async () => {
    try {
      await fetchJSON(`/api/members/${m.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive: checkbox.checked }),
      });
      m.isActive = checkbox.checked;
      // Refresh the card class without re-rendering everything
      card.classList.toggle('is-inactive', !m.isActive);
      renderWorkspaceCard();
      toast(`${m.name} ${m.isActive ? 'activated' : 'deactivated'}.`, 'ok');
    } catch (e) {
      checkbox.checked = !checkbox.checked;
      toast('Could not update: ' + e.message, 'err');
    }
  });
  head.appendChild(toggle);
  card.appendChild(head);

  const exp = h('div', { class: 'expertise' });
  (m.expertise || []).forEach((e) => exp.appendChild(h('span', { class: 'expertise-tag' }, e)));
  card.appendChild(exp);

  card.appendChild(h('div', { class: 'persona-preview' }, m.persona));

  // Action buttons row
  const actions = h('div', { class: 'card-actions' });
  const editBtn = h('button', { class: 'btn-secondary', 'data-testid': 'member-edit-btn' }, 'Edit');
  editBtn.addEventListener('click', () => openMemberEditModal(m));
  const voiceBtn = h('button', { class: 'btn-secondary', 'data-testid': 'member-voice-btn', title: 'Regenerate voice guide with the fast model' }, '🔊 Voice');
  voiceBtn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    voiceBtn.disabled = true;
    const prev = voiceBtn.textContent;
    voiceBtn.textContent = 'Refreshing…';
    try {
      const r = await fetchJSON(`/api/members/${m.id}/regenerate-voice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preview: true }),
      });
      const ok = window.confirm(`New voice guide:\n\n${r.voiceGuide}\n\nSave?`);
      if (ok) {
        await fetchJSON(`/api/members/${m.id}/regenerate-voice`, { method: 'POST' });
        toast(`${m.name}: voice guide saved.`, 'ok');
        await refreshState({ silent: true });
        if (state.route === 'members') navigate('members');
      } else {
        toast('Voice guide preview only — not saved.', '');
      }
    } catch (e) {
      toast('Voice failed: ' + e.message, 'err');
    } finally {
      voiceBtn.disabled = false;
      voiceBtn.textContent = prev;
    }
  });
  const delBtn = h('button', { class: 'btn-danger-ghost', 'data-testid': 'member-delete-btn' }, 'Delete');
  delBtn.addEventListener('click', () =>
    openConfirmModal({
      title: `Delete ${m.name}?`,
      message: `This removes the member, their .claude/agents/${m.slug || initialsOf(m.name)}.md file (if AAB-generated), and they won't appear in future discussions.`,
      okLabel: 'Delete',
      onOk: async () => {
        try {
          await fetchJSON(`/api/members/${m.id}`, { method: 'DELETE' });
          await refreshState({ silent: true });
          renderWorkspaceCard();
          navigate('members');
          toast(`${m.name} deleted.`, 'ok');
        } catch (e) {
          toast('Could not delete: ' + e.message, 'err');
        }
      },
    }),
  );
  actions.appendChild(editBtn);
  actions.appendChild(voiceBtn);
  actions.appendChild(delBtn);
  card.appendChild(actions);

  return card;
}

// ------------------------------------------------------------------
// Actions (kanban) view
// ------------------------------------------------------------------

function renderActionsView(main) {
  const view = h('div', { class: 'view', 'data-testid': 'actions-view' });
  const header = h('div', { class: 'view-header' });
  header.appendChild(
    h('div', {}, [
      h('div', { class: 'view-title' }, 'Action Board'),
      h(
        'div',
        { class: 'view-subtitle' },
        `${state.actionItems.length} action item${state.actionItems.length === 1 ? '' : 's'}`,
      ),
    ]),
  );
  const headerActions = h('div', { class: 'header-actions' });
  const addBtn = h(
    'button',
    { class: 'btn-primary', 'data-testid': 'actions-add-btn' },
    '+ Add action',
  );
  addBtn.addEventListener('click', () => openActionEditModal(null));
  headerActions.appendChild(addBtn);
  header.appendChild(headerActions);
  view.appendChild(header);

  const body = h('div', { class: 'view-body' });

  if (state.actionItems.length === 0) {
    body.appendChild(
      emptyState(
        '📋',
        'No action items yet',
        'Click "+ Add action", or open a concluded discussion and use "Extract actions".',
      ),
    );
  } else {
    body.appendChild(renderKanbanBoard(state.actionItems));
  }

  view.appendChild(body);
  main.appendChild(view);
}

function renderKanbanBoard(items) {
  const board = h('div', { class: 'kanban', 'data-testid': 'kanban-board' });
  for (const status of ['pending', 'in-progress', 'completed']) {
    const colItems = items.filter((a) => a.status === status);
    const col = h('div', {
      class: 'kanban-col',
      'data-testid': `kanban-col-${status}`,
      'data-status': status,
    });
    col.appendChild(
      h('div', { class: 'kanban-col-head' }, [
        h('span', {}, status),
        h('span', { class: 'kanban-col-count' }, String(colItems.length)),
      ]),
    );
    const cards = h('div', { class: 'kanban-cards', 'data-status': status });
    for (const a of colItems) cards.appendChild(actionCard(a));
    col.appendChild(cards);
    wireDropTarget(col, status);
    wireDropTarget(cards, status);
    board.appendChild(col);
  }
  return board;
}

function actionCard(a) {
  const card = h('div', {
    class: 'kanban-card',
    'data-testid': 'kanban-card',
    'data-action-id': a.id,
    'data-priority': a.priority,
    draggable: 'true',
  });
  card.appendChild(
    h('div', { class: 'kanban-card-title', 'data-testid': 'kanban-card-title' }, a.title),
  );
  if (a.description) {
    card.appendChild(
      h('div', { class: 'kanban-card-desc' }, ellipsisJs(a.description, 140)),
    );
  }
  const meta = h('div', { class: 'kanban-card-meta' });
  meta.appendChild(h('span', { class: 'priority-mark ' + a.priority }));
  meta.appendChild(h('span', {}, a.priority));
  if (a.dueDate) meta.appendChild(h('span', {}, '· due ' + a.dueDate.slice(0, 10)));
  if (a.assignedTo) meta.appendChild(h('span', {}, '· ' + a.assignedTo));
  card.appendChild(meta);
  if (a.linkedSkill) {
    card.appendChild(h('div', { class: 'message-meta' }, `🧠 skill: ${a.linkedSkill.name}`));
  }
  // Phase 5 — Plan + Solve buttons (visible on every action card).
  const actionsRow = h('div', { class: 'kanban-card-actions' });
  const planBtn = h('button', {
    class: 'kanban-card-action btn-secondary',
    'data-testid': 'plan-btn',
    'data-action-id': a.id,
    type: 'button',
  }, '🔭 Plan');
  planBtn.addEventListener('click', (ev) => { ev.stopPropagation(); launchSkillPlan(a); });
  const solveBtn = h('button', {
    class: 'kanban-card-action btn-primary',
    'data-testid': 'solve-btn',
    'data-action-id': a.id,
    type: 'button',
  }, '⚡ Solve');
  solveBtn.addEventListener('click', (ev) => { ev.stopPropagation(); launchSkillSolve(a); });
  actionsRow.appendChild(planBtn);
  actionsRow.appendChild(solveBtn);
  card.appendChild(actionsRow);
  card.addEventListener('click', (ev) => {
    if (ev.target.closest('.kanban-card-action')) return;
    openActionEditModal(a);
  });
  card.addEventListener('dragstart', (ev) => {
    card.classList.add('dragging');
    ev.dataTransfer.setData('text/plain', a.id);
    ev.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
  });
  return card;
}

function wireDropTarget(el, status) {
  el.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    el.classList.remove('drop-target');
    const id = ev.dataTransfer.getData('text/plain');
    if (!id) return;
    const item = state.actionItems.find((a) => a.id === id);
    if (!item || item.status === status) return;
    // Optimistic update.
    const prevStatus = item.status;
    item.status = status;
    try {
      navigate('actions');
      await fetchJSON(`/api/actions/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      toast(`Moved to ${status}`, 'ok');
    } catch (e) {
      item.status = prevStatus;
      toast('Move failed: ' + e.message, 'err');
      navigate('actions');
    }
  });
}

function ellipsisJs(s, max) {
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s;
}

// Action-item add / edit modal — single-form panel covering all CRUD fields.
function openActionEditModal(item) {
  const isEdit = !!item;
  const backdrop = h('div', {
    class: 'modal-backdrop',
    'data-testid': 'action-edit-modal',
  });
  const close = () => backdrop.remove();
  const inner = h('div', { class: 'modal' });

  const titleInput = h('input', {
    type: 'text',
    class: 'modal-input',
    'data-testid': 'action-title-input',
    placeholder: 'Action title',
    value: item?.title || '',
  });
  const descInput = h('textarea', {
    rows: '4',
    'data-testid': 'action-desc-input',
    placeholder: 'Description (what needs doing?)',
  });
  descInput.value = item?.description || '';
  const prioritySelect = h('select', {
    class: 'modal-select',
    'data-testid': 'action-priority-select',
  });
  for (const p of ['low', 'medium', 'high']) {
    const opt = h('option', { value: p }, p);
    if ((item?.priority || 'medium') === p) opt.selected = true;
    prioritySelect.appendChild(opt);
  }
  const statusSelect = h('select', { class: 'modal-select', 'data-testid': 'action-status-select' });
  for (const s of ['pending', 'in-progress', 'completed']) {
    const opt = h('option', { value: s }, s);
    if ((item?.status || 'pending') === s) opt.selected = true;
    statusSelect.appendChild(opt);
  }
  const dueInput = h('input', {
    type: 'date',
    class: 'modal-input',
    'data-testid': 'action-due-input',
    value: item?.dueDate?.slice(0, 10) || '',
  });
  const assigneeInput = h('input', {
    type: 'text',
    class: 'modal-input',
    placeholder: 'Assignee (optional)',
    'data-testid': 'action-assignee-input',
    value: item?.assignedTo || '',
  });

  const header = h('div', { class: 'modal-header' });
  header.appendChild(h('h2', {}, isEdit ? 'Edit action' : 'New action item'));
  const closeBtn = h(
    'button',
    { class: 'icon-btn', 'aria-label': 'Close', type: 'button', 'data-testid': 'action-edit-close' },
    '×',
  );
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  inner.appendChild(header);

  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('label', { class: 'field-label' }, 'Title'));
  body.appendChild(titleInput);
  body.appendChild(h('label', { class: 'field-label' }, 'Description'));
  body.appendChild(descInput);
  const row1 = h('div', { class: 'modal-row' });
  row1.appendChild(
    h('div', {}, [h('label', { class: 'field-label' }, 'Priority'), prioritySelect]),
  );
  row1.appendChild(h('div', {}, [h('label', { class: 'field-label' }, 'Status'), statusSelect]));
  body.appendChild(row1);
  const row2 = h('div', { class: 'modal-row' });
  row2.appendChild(h('div', {}, [h('label', { class: 'field-label' }, 'Due date'), dueInput]));
  row2.appendChild(h('div', {}, [h('label', { class: 'field-label' }, 'Assignee'), assigneeInput]));
  body.appendChild(row2);
  inner.appendChild(body);

  const foot = h('div', { class: 'modal-footer' });
  if (isEdit) {
    const delBtn = h(
      'button',
      { class: 'btn-secondary', type: 'button', 'data-testid': 'action-delete-btn' },
      'Delete',
    );
    delBtn.addEventListener('click', async () => {
      if (!window.confirm('Delete this action item?')) return;
      try {
        await fetchJSON(`/api/actions/${item.id}`, { method: 'DELETE' });
        toast('Deleted', 'ok');
        await refreshState({ silent: true });
        close();
        navigate('actions');
      } catch (e) {
        toast('Delete failed: ' + e.message, 'err');
      }
    });
    foot.appendChild(delBtn);
    foot.appendChild(h('div', { style: 'flex:1' }));
  }
  const cancelBtn = h(
    'button',
    { class: 'btn-secondary', type: 'button' },
    'Cancel',
  );
  cancelBtn.addEventListener('click', close);
  foot.appendChild(cancelBtn);
  const saveBtn = h(
    'button',
    { class: 'btn-primary', type: 'button', 'data-testid': 'action-save-btn' },
    isEdit ? 'Save' : 'Create',
  );
  saveBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) {
      toast('Title is required.', 'err');
      return;
    }
    const payload = {
      title,
      description: descInput.value,
      priority: prioritySelect.value,
      status: statusSelect.value,
      dueDate: dueInput.value || '',
      assignedTo: assigneeInput.value || '',
    };
    saveBtn.disabled = true;
    try {
      if (isEdit) {
        await fetchJSON(`/api/actions/${item.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Updated', 'ok');
      } else {
        await fetchJSON('/api/actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Created', 'ok');
      }
      await refreshState({ silent: true });
      close();
      navigate('actions');
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
      saveBtn.disabled = false;
    }
  });
  foot.appendChild(saveBtn);
  inner.appendChild(foot);

  backdrop.appendChild(inner);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  setTimeout(() => titleInput.focus(), 0);
}

// "Extract actions" modal — runs the analyzer, then lets the user accept/reject each candidate.
async function openExtractActionsModal(discussion) {
  const backdrop = h('div', {
    class: 'modal-backdrop',
    'data-testid': 'extract-actions-modal',
  });
  const close = () => backdrop.remove();
  const inner = h('div', { class: 'modal modal-wide' });

  const header = h('div', { class: 'modal-header' });
  header.appendChild(h('h2', {}, 'Extract action items'));
  const closeBtn = h(
    'button',
    { class: 'icon-btn', 'aria-label': 'Close', type: 'button', 'data-testid': 'extract-close-btn' },
    '×',
  );
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  inner.appendChild(header);

  const body = h('div', { class: 'modal-body', 'data-testid': 'extract-body' });
  const statusLine = h(
    'div',
    { class: 'message-meta', 'data-testid': 'extract-status' },
    'Running analyzer…',
  );
  body.appendChild(statusLine);
  const list = h('div', { class: 'extract-candidates', 'data-testid': 'extract-list' });
  body.appendChild(list);
  inner.appendChild(body);

  const foot = h('div', { class: 'modal-footer' });
  const cancel = h('button', { class: 'btn-secondary', type: 'button' }, 'Close');
  cancel.addEventListener('click', close);
  foot.appendChild(cancel);
  const acceptBtn = h(
    'button',
    {
      class: 'btn-primary',
      type: 'button',
      'data-testid': 'extract-accept-btn',
      disabled: 'disabled',
    },
    'Accept selected',
  );
  foot.appendChild(acceptBtn);
  inner.appendChild(foot);

  backdrop.appendChild(inner);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close();
  });
  document.body.appendChild(backdrop);

  let candidates = [];
  const selected = new Set();
  try {
    const result = await fetchJSON(`/api/discussions/${discussion.id}/actions/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    candidates = result.candidates || [];
    statusLine.textContent = `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} via ${result.method} (conf ${result.analysisConfidence}/100)`;
    if (candidates.length === 0) {
      list.appendChild(emptyState('🪶', 'No candidates', 'No structured signal — and the LLM fallback produced nothing actionable.'));
    }
    candidates.forEach((cand, idx) => {
      const row = h('div', {
        class: 'extract-row',
        'data-testid': 'extract-row',
        'data-index': String(idx),
      });
      const cb = h('input', {
        type: 'checkbox',
        class: 'extract-checkbox',
        'data-testid': 'extract-checkbox',
      });
      cb.checked = true;
      selected.add(idx);
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(idx);
        else selected.delete(idx);
        acceptBtn.disabled = selected.size === 0;
      });
      const main = h('div', { class: 'extract-row-main' });
      main.appendChild(
        h('div', { class: 'extract-row-title' }, cand.title || '(untitled)'),
      );
      if (cand.description) {
        main.appendChild(h('div', { class: 'extract-row-desc' }, cand.description));
      }
      main.appendChild(
        h(
          'div',
          { class: 'message-meta' },
          `${cand.priority} · ${cand.category} · conf ${cand.confidence}${cand.suggestedAssignee ? ' · ' + cand.suggestedAssignee : ''}${cand.suggestedDueDate ? ' · ' + cand.suggestedDueDate : ''}`,
        ),
      );
      row.appendChild(cb);
      row.appendChild(main);
      list.appendChild(row);
    });
    acceptBtn.disabled = selected.size === 0;
  } catch (e) {
    statusLine.textContent = 'Extract failed: ' + e.message;
    statusLine.classList.add('error');
  }

  acceptBtn.addEventListener('click', async () => {
    const accepted = [...selected].map((i) => candidates[i]).filter(Boolean);
    if (accepted.length === 0) return;
    acceptBtn.disabled = true;
    try {
      const result = await fetchJSON(`/api/discussions/${discussion.id}/actions/extract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accept: accepted }),
      });
      toast(`Created ${result.created.length} action item${result.created.length === 1 ? '' : 's'}`, 'ok');
      await refreshState({ silent: true });
      close();
      navigate('actions');
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
      acceptBtn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------
// Principles view
// ------------------------------------------------------------------

function renderPrinciplesView(main) {
  const view = h('div', { class: 'view' });
  const activeCount = state.principles.filter((p) => p.isActive).length;
  const header = h('div', { class: 'view-header' }, [
    h('div', {}, [
      h('div', { class: 'view-title' }, 'Principles'),
      h(
        'div',
        { class: 'view-subtitle' },
        `${activeCount} active · ${state.principles.length} total`,
      ),
    ]),
  ]);
  const headerActions = h('div', { class: 'header-actions' });
  const seedBtn = h(
    'button',
    {
      class: 'btn-secondary',
      'data-testid': 'principles-seed-btn',
      title: state.principles.length > 0 ? 'Already seeded; disabled' : 'Seed 8 Dalio-inspired starter principles',
    },
    '🌱 Seed starters',
  );
  if (state.principles.length > 0) seedBtn.disabled = true;
  seedBtn.addEventListener('click', async () => {
    if (seedBtn.disabled) return;
    seedBtn.disabled = true;
    const prev = seedBtn.textContent;
    seedBtn.textContent = 'Seeding…';
    try {
      const r = await fetchJSON('/api/principles/seed-starters', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      toast(`Seeded ${r.added} starter principle${r.added === 1 ? '' : 's'}.`, 'ok');
      await refreshState({ silent: true });
      navigate('principles');
    } catch (e) {
      toast('Seed failed: ' + e.message, 'err');
      seedBtn.disabled = false;
      seedBtn.textContent = prev;
    }
  });
  const addBtn = h('button', { class: 'btn-primary', 'data-testid': 'principles-add-btn' }, '+ Add principle');
  addBtn.addEventListener('click', () => openPrincipleEditModal(null));
  headerActions.appendChild(seedBtn);
  headerActions.appendChild(addBtn);
  header.appendChild(headerActions);
  view.appendChild(header);

  const body = h('div', { class: 'view-body' });
  if (state.principles.length === 0) {
    const empty = emptyState(
      '🧭',
      'No principles yet',
      'Add one, or run `aab init` to seed Dalio-inspired starters.',
    );
    const seedBtn = h('button', { class: 'btn-primary', style: 'margin-top:12px' }, '+ Add a principle');
    seedBtn.addEventListener('click', () => openPrincipleEditModal(null));
    empty.appendChild(seedBtn);
    body.appendChild(empty);
  } else {
    const grid = h('div', { class: 'principles-grid' });
    for (const p of state.principles) grid.appendChild(principleCard(p));
    body.appendChild(grid);
  }
  view.appendChild(body);
  main.appendChild(view);
}

function principleCard(p) {
  const card = h('div', { class: 'principle-card' + (p.isActive ? '' : ' is-inactive') });
  const head = h('div', { class: 'principle-head' }, [
    h('div', { class: 'principle-title' }, p.title),
    h('div', { class: 'principle-cat' }, p.category),
  ]);
  // Switch
  const toggle = h('label', { class: 'switch' });
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!p.isActive;
  cb.addEventListener('click', (ev) => ev.stopPropagation());
  cb.addEventListener('change', async () => {
    try {
      await fetchJSON(`/api/principles/${p.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive: cb.checked }),
      });
      p.isActive = cb.checked;
      card.classList.toggle('is-inactive', !p.isActive);
      toast(`Principle ${p.isActive ? 'activated' : 'deactivated'}.`, 'ok');
    } catch (e) {
      cb.checked = !cb.checked;
      toast('Could not update: ' + e.message, 'err');
    }
  });
  toggle.appendChild(cb);
  toggle.appendChild(h('span', { class: 'switch-track' }));
  head.appendChild(toggle);
  card.appendChild(head);

  card.appendChild(h('div', { class: 'principle-desc' }, p.description));
  const row = h('div', { class: 'priority-row' });
  row.appendChild(h('span', {}, `priority ${p.priority}/10`));
  const bar = h('div', { class: 'priority-bar' });
  bar.appendChild(h('div', { class: 'priority-bar-fill', style: `width: ${p.priority * 10}%` }));
  row.appendChild(bar);
  card.appendChild(row);

  const actions = h('div', { class: 'card-actions' });
  const exploreBtn = h(
    'button',
    {
      class: 'btn-secondary',
      'data-testid': 'principle-explore-btn',
      title: '5-step Socratic wizard to refine behavior / anti-pattern / triggers / examples / priority',
    },
    '🔎 Explore',
  );
  exploreBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openExplorerWizard(p);
  });
  actions.appendChild(exploreBtn);
  card.appendChild(actions);

  card.addEventListener('click', () => openPrincipleEditModal(p));
  card.style.cursor = 'pointer';
  return card;
}

// ------------------------------------------------------------------
// Settings view
// ------------------------------------------------------------------

function renderSettingsView(main) {
  const view = h('div', { class: 'view' });
  view.appendChild(
    h('div', { class: 'view-header' }, [
      h('div', {}, [
        h('div', { class: 'view-title' }, 'Settings'),
        h('div', { class: 'view-subtitle' }, 'Workspace-level configuration'),
      ]),
    ]),
  );
  const body = h('div', { class: 'view-body' });
  const form = h('div', { class: 'settings-form' });

  const s = state.settings || {};

  const fieldDefs = [
    { key: 'boardTitle', label: 'Board title', type: 'text', help: 'Shown at the top of the dashboard.' },
    { key: 'maxMembersPerDiscussion', label: 'Max members per discussion', type: 'number', min: 1, max: 12 },
    { key: 'maxTurnsPerDiscussion', label: 'Max turns per discussion', type: 'number', min: 2, max: 30, help: 'When totalTurns hits this, the discussion auto-concludes.' },
    {
      key: 'orchestratorPromptStyle',
      label: 'Orchestrator style',
      type: 'select',
      options: ['analytical', 'creative', 'balanced'],
    },
    { key: 'autoSummarization', label: 'Auto-summarize on conclude', type: 'switch' },
    { key: 'consensusThreshold', label: 'Consensus threshold (%)', type: 'number', min: 0, max: 100 },
    { key: 'enableUserInteraction', label: 'Enable HITL (orchestrator can ask you questions)', type: 'switch' },
    {
      key: 'primaryModel',
      label: 'Primary model (members)',
      type: 'select',
      options: ['inherit', 'opus', 'sonnet', 'haiku', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'],
    },
    {
      key: 'researchModel',
      label: 'Research model (skill task research, sparring)',
      type: 'select',
      options: ['inherit', 'opus', 'sonnet', 'haiku', 'claude-opus-4-7', 'claude-sonnet-4-6'],
    },
    {
      key: 'fastModel',
      label: 'Fast model (orchestrator)',
      type: 'select',
      options: ['inherit', 'opus', 'sonnet', 'haiku', 'claude-haiku-4-5-20251001'],
    },
    { key: 'perCallBudgetUsd', label: 'Per-call budget (USD)', type: 'number', step: '0.5', min: 0, help: 'Passed to claude --max-budget-usd.' },
    { key: 'locale', label: 'Locale', type: 'text' },
  ];

  const inputs = {};
  for (const f of fieldDefs) {
    const wrap = h('div', { class: 'form-field' });
    wrap.appendChild(h('label', { class: 'field-label' }, f.label));
    if (f.type === 'switch') {
      const lbl = h('label', { class: 'switch' });
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !!s[f.key];
      lbl.appendChild(cb);
      lbl.appendChild(h('span', { class: 'switch-track' }));
      wrap.appendChild(lbl);
      inputs[f.key] = cb;
    } else if (f.type === 'select') {
      const sel = h('select');
      for (const opt of f.options) {
        const o = h('option', { value: opt }, opt);
        if (s[f.key] === opt) o.selected = true;
        sel.appendChild(o);
      }
      wrap.appendChild(sel);
      inputs[f.key] = sel;
    } else {
      const attrs = { type: f.type };
      if (f.min != null) attrs.min = String(f.min);
      if (f.max != null) attrs.max = String(f.max);
      if (f.step) attrs.step = f.step;
      const inp = h('input', attrs);
      inp.value = s[f.key] != null ? String(s[f.key]) : '';
      wrap.appendChild(inp);
      inputs[f.key] = inp;
    }
    if (f.help) wrap.appendChild(h('div', { class: 'field-help' }, f.help));
    form.appendChild(wrap);
  }

  const actions = h('div', { class: 'form-actions' });
  const saveBtn = h('button', { class: 'btn-primary' }, 'Save settings');
  const resetBtn = h('button', { class: 'btn-secondary' }, 'Reset form');
  resetBtn.addEventListener('click', () => navigate('settings'));
  saveBtn.addEventListener('click', async () => {
    const payload = {};
    for (const f of fieldDefs) {
      const inp = inputs[f.key];
      if (f.type === 'switch') payload[f.key] = inp.checked;
      else if (f.type === 'number') {
        const v = inp.value;
        if (v === '' || v == null) continue;
        payload[f.key] = Number(v);
      } else {
        payload[f.key] = inp.value;
      }
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const updated = await fetchJSON('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      state.settings = updated;
      toast('Settings saved.', 'ok');
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save settings';
    }
  });
  actions.appendChild(saveBtn);
  actions.appendChild(resetBtn);
  form.appendChild(actions);

  body.appendChild(form);
  view.appendChild(body);
  main.appendChild(view);
}

// ------------------------------------------------------------------
// Edit modal (members + principles share this)
// ------------------------------------------------------------------

let editModalOnSave = null;
let editModalOnDelete = null;

function setupEditModal() {
  $('#edit-modal-close').addEventListener('click', closeEditModal);
  $('#edit-modal-cancel').addEventListener('click', closeEditModal);
  $('#edit-modal-save').addEventListener('click', async () => {
    if (!editModalOnSave) return;
    const btn = $('#edit-modal-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await editModalOnSave();
      closeEditModal();
    } catch (e) {
      toast('Save failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });
  $('#edit-modal-delete').addEventListener('click', () => {
    if (editModalOnDelete) editModalOnDelete();
  });
}

function closeEditModal() {
  $('#edit-modal').hidden = true;
  $('#edit-modal-body').innerHTML = '';
  editModalOnSave = null;
  editModalOnDelete = null;
  $('#edit-modal-delete').hidden = true;
}

function openMemberEditModal(member) {
  const isNew = !member;
  $('#edit-modal-title').textContent = isNew ? 'Add board member' : `Edit ${member.name}`;
  const body = $('#edit-modal-body');
  body.innerHTML = '';

  const fields = {
    name: input('Name', member?.name || '', 'e.g. Sam Altman'),
    title: input('Title', member?.title || '', 'e.g. CEO, OpenAI'),
    expertise: input(
      'Expertise (comma-separated)',
      (member?.expertise || []).join(', '),
      'e.g. AI strategy, scaling, product',
    ),
    persona: textarea(
      'Persona (1-2 paragraphs)',
      member?.persona || '',
      "How they think, what they're known for. Used in the agent's system prompt.",
      6,
    ),
    voiceGuide: textarea(
      'Voice guide (optional)',
      member?.voiceGuide || '',
      'Style, vocabulary, characteristic phrases. Helps the LLM sound like them.',
      3,
    ),
  };
  for (const [k, frag] of Object.entries(fields)) body.appendChild(frag.wrap);

  // ------- AI enhance row -------
  const enhanceRow = h('div', { class: 'form-field' });
  enhanceRow.appendChild(h('label', { class: 'field-label' }, 'AI enhance (fills persona + voice)'));
  const enhanceWrap = h('div', { class: 'enhance-row' });
  const enhanceTypeSel = h('select', { 'data-testid': 'enhance-type-select' });
  for (const opt of [
    { v: 'non-famous', label: 'Practitioner' },
    { v: 'expert', label: 'Top-1% expert' },
    { v: 'famous', label: 'Famous leader' },
  ]) {
    const o = h('option', { value: opt.v }, opt.label);
    enhanceTypeSel.appendChild(o);
  }
  const enhanceBtn = h('button', { class: 'btn-secondary', 'data-testid': 'enhance-with-ai-btn' }, '✨ Enhance with AI');
  const enhanceStatus = h('span', { class: 'field-help' }, '');
  enhanceBtn.addEventListener('click', async () => {
    const name = fields.name.input.value.trim();
    const title = fields.title.input.value.trim();
    if (!name || !title) {
      toast('Set name + title before enhancing.', 'err');
      return;
    }
    if (!member) {
      // Need to create a draft first.
      toast('Save the member first, then click "Enhance with AI" from the edit modal.', 'err');
      return;
    }
    enhanceBtn.disabled = true;
    enhanceBtn.textContent = 'Enhancing…';
    enhanceStatus.textContent = 'Calling claude…';
    try {
      // Fire-and-watch via WS — server returns 202 + memberId.
      await fetchJSON(`/api/members/${member.id}/enhance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: enhanceTypeSel.value, keepVoice: false }),
      });
      // Listen for the member_enhance_done WS event.
      const onEvent = (ev) => {
        const d = ev.detail || {};
        if (d.memberId !== member.id) return;
        if (d.type === 'member_enhance_progress') {
          enhanceStatus.textContent = `Working… ${d.event?.type || ''}`;
        } else if (d.type === 'member_enhance_done') {
          enhanceStatus.textContent = 'Done.';
          // Fill the modal fields with the new content (don't auto-close).
          if (d.member?.persona) fields.persona.input.value = d.member.persona;
          if (d.member?.voiceGuide) fields.voiceGuide.input.value = d.member.voiceGuide;
          enhanceBtn.disabled = false;
          enhanceBtn.textContent = '✨ Enhance with AI';
          window.removeEventListener('aab-member-event', onEvent);
          refreshState({ silent: true });
          toast(`${member.name}: AI-enhanced persona ready.`, 'ok');
        } else if (d.type === 'member_enhance_failed') {
          enhanceStatus.textContent = 'Failed: ' + (d.message || 'unknown');
          enhanceBtn.disabled = false;
          enhanceBtn.textContent = '✨ Enhance with AI';
          window.removeEventListener('aab-member-event', onEvent);
          toast('Enhance failed: ' + d.message, 'err');
        }
      };
      window.addEventListener('aab-member-event', onEvent);
    } catch (e) {
      enhanceBtn.disabled = false;
      enhanceBtn.textContent = '✨ Enhance with AI';
      enhanceStatus.textContent = '';
      toast('Enhance failed: ' + e.message, 'err');
    }
  });
  enhanceWrap.appendChild(enhanceTypeSel);
  enhanceWrap.appendChild(enhanceBtn);
  enhanceWrap.appendChild(enhanceStatus);
  enhanceRow.appendChild(enhanceWrap);
  body.appendChild(enhanceRow);

  // ------- Tools allowlist editor -------
  const toolsRow = h('div', { class: 'form-field' });
  toolsRow.appendChild(h('label', { class: 'field-label' }, 'Allowed tools (per-member override)'));
  const toolsHelp = h('div', { class: 'field-help' }, 'Leave all unchecked to use the workspace default (WebSearch, WebFetch, Read, Grep, Glob).');
  toolsRow.appendChild(toolsHelp);
  const toolsBox = h('div', { class: 'tools-chips', 'data-testid': 'member-tools-allowlist' });
  const TOOL_PALETTE = ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'];
  const currentAllowed = new Set(member?.allowedTools ?? []);
  const toolInputs = {};
  for (const tool of TOOL_PALETTE) {
    const lbl = h('label', { class: 'tool-chip' });
    const cb = h('input', { type: 'checkbox', 'data-tool': tool });
    cb.checked = currentAllowed.has(tool);
    lbl.appendChild(cb);
    lbl.appendChild(h('span', {}, tool));
    toolsBox.appendChild(lbl);
    toolInputs[tool] = cb;
  }
  toolsRow.appendChild(toolsBox);
  body.appendChild(toolsRow);
  fields._tools = toolInputs;

  if (!isNew) {
    body.appendChild(
      h('label', { class: 'switch-row' }, [
        h('span', {}, 'Active'),
        (() => {
          const lbl = h('label', { class: 'switch' });
          const cb = h('input', { type: 'checkbox' });
          cb.checked = !!member.isActive;
          lbl.appendChild(cb);
          lbl.appendChild(h('span', { class: 'switch-track' }));
          fields.isActive = { input: cb };
          return lbl;
        })(),
      ]),
    );
    $('#edit-modal-delete').hidden = false;
    editModalOnDelete = () =>
      openConfirmModal({
        title: `Delete ${member.name}?`,
        message: 'This will also remove the corresponding agent file if it was AAB-generated.',
        okLabel: 'Delete',
        onOk: async () => {
          try {
            await fetchJSON(`/api/members/${member.id}`, { method: 'DELETE' });
            await refreshState({ silent: true });
            renderWorkspaceCard();
            closeEditModal();
            navigate('members');
            toast(`${member.name} deleted.`, 'ok');
          } catch (e) {
            toast('Could not delete: ' + e.message, 'err');
          }
        },
      });
  }

  $('#edit-modal').hidden = false;
  fields.name.input.focus();

  editModalOnSave = async () => {
    const name = fields.name.input.value.trim();
    if (!name) {
      toast('Name is required.', 'err');
      throw new Error('Name is required.');
    }
    const payload = {
      name,
      title: fields.title.input.value.trim(),
      expertise: fields.expertise.input.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      persona: fields.persona.input.value.trim(),
      voiceGuide: fields.voiceGuide.input.value.trim() || undefined,
    };
    if (!isNew) payload.isActive = fields.isActive.input.checked;
    // Tools allowlist — only send if the user explicitly checked some tools
    // (an empty `allowedTools` means "use the workspace default").
    const pickedTools = Object.entries(fields._tools || {})
      .filter(([, cb]) => cb.checked)
      .map(([t]) => t);
    if (pickedTools.length > 0) payload.allowedTools = pickedTools;
    else if (!isNew) payload.allowedTools = []; // explicit clear

    if (isNew) {
      await fetchJSON('/api/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(`${name} added.`, 'ok');
    } else {
      await fetchJSON(`/api/members/${member.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(`${name} updated.`, 'ok');
    }
    await refreshState({ silent: true });
    renderWorkspaceCard();
    if (state.route === 'members') navigate('members');
  };
}

function openPrincipleEditModal(principle) {
  const isNew = !principle;
  $('#edit-modal-title').textContent = isNew ? 'Add principle' : `Edit ${principle.title}`;
  const body = $('#edit-modal-body');
  body.innerHTML = '';

  const fields = {
    title: input('Title', principle?.title || '', 'e.g. Embrace Radical Truth'),
    description: textarea(
      'Description',
      principle?.description || '',
      'What this principle means in plain language.',
      4,
    ),
    behavior: textarea(
      'Behavior (when applied well)',
      principle?.behavior || '',
      'What it looks like in action.',
      3,
    ),
    category: select(
      'Category',
      ['life', 'work', 'relationships', 'health', 'finance', 'meta'],
      principle?.category || 'meta',
    ),
    priority: input('Priority (1-10)', String(principle?.priority ?? 5), '5', 'number'),
  };
  for (const frag of Object.values(fields)) body.appendChild(frag.wrap);

  if (!isNew) {
    body.appendChild(
      h('label', { class: 'switch-row' }, [
        h('span', {}, 'Active'),
        (() => {
          const lbl = h('label', { class: 'switch' });
          const cb = h('input', { type: 'checkbox' });
          cb.checked = !!principle.isActive;
          lbl.appendChild(cb);
          lbl.appendChild(h('span', { class: 'switch-track' }));
          fields.isActive = { input: cb };
          return lbl;
        })(),
      ]),
    );
    $('#edit-modal-delete').hidden = false;
    editModalOnDelete = () =>
      openConfirmModal({
        title: `Delete "${principle.title}"?`,
        message: 'This removes the principle from the workspace.',
        okLabel: 'Delete',
        onOk: async () => {
          try {
            await fetchJSON(`/api/principles/${principle.id}`, { method: 'DELETE' });
            await refreshState({ silent: true });
            closeEditModal();
            navigate('principles');
            toast(`Principle deleted.`, 'ok');
          } catch (e) {
            toast('Could not delete: ' + e.message, 'err');
          }
        },
      });
  }

  $('#edit-modal').hidden = false;
  fields.title.input.focus();

  editModalOnSave = async () => {
    const title = fields.title.input.value.trim();
    if (!title) {
      toast('Title is required.', 'err');
      throw new Error('Title is required.');
    }
    const payload = {
      title,
      description: fields.description.input.value.trim(),
      behavior: fields.behavior.input.value.trim(),
      category: fields.category.input.value,
      priority: Number(fields.priority.input.value) || 5,
    };
    if (!isNew) payload.isActive = fields.isActive.input.checked;

    if (isNew) {
      await fetchJSON('/api/principles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(`"${title}" added.`, 'ok');
    } else {
      await fetchJSON(`/api/principles/${principle.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(`"${title}" updated.`, 'ok');
    }
    await refreshState({ silent: true });
    if (state.route === 'principles') navigate('principles');
  };
}

// Form-field helpers used by edit modals
function input(label, value, placeholder, type = 'text') {
  const wrap = h('div', { class: 'form-field' });
  wrap.appendChild(h('label', { class: 'field-label' }, label));
  const inp = h('input', { type, placeholder: placeholder || '' });
  inp.value = value || '';
  wrap.appendChild(inp);
  return { wrap, input: inp };
}

function textarea(label, value, placeholder, rows = 3) {
  const wrap = h('div', { class: 'form-field' });
  wrap.appendChild(h('label', { class: 'field-label' }, label));
  const ta = h('textarea', { rows: String(rows), placeholder: placeholder || '' });
  ta.value = value || '';
  wrap.appendChild(ta);
  return { wrap, input: ta };
}

function select(label, options, value) {
  const wrap = h('div', { class: 'form-field' });
  wrap.appendChild(h('label', { class: 'field-label' }, label));
  const sel = h('select');
  for (const opt of options) {
    const o = h('option', { value: opt }, opt);
    if (opt === value) o.selected = true;
    sel.appendChild(o);
  }
  wrap.appendChild(sel);
  return { wrap, input: sel };
}

// ------------------------------------------------------------------
// Confirm modal
// ------------------------------------------------------------------

let confirmOnOk = null;

function setupConfirmModal() {
  $('#confirm-modal-close').addEventListener('click', closeConfirmModal);
  $('#confirm-modal-cancel').addEventListener('click', closeConfirmModal);
  $('#confirm-modal-ok').addEventListener('click', async () => {
    const ok = $('#confirm-modal-ok');
    ok.disabled = true;
    try {
      if (confirmOnOk) await confirmOnOk();
    } finally {
      ok.disabled = false;
      closeConfirmModal();
    }
  });
}

function openConfirmModal({ title, message, okLabel = 'Confirm', onOk }) {
  $('#confirm-modal-title').textContent = title || 'Are you sure?';
  $('#confirm-modal-message').textContent = message || '';
  $('#confirm-modal-ok').textContent = okLabel;
  confirmOnOk = onOk || null;
  $('#confirm-modal').hidden = false;
}

function closeConfirmModal() {
  $('#confirm-modal').hidden = true;
  confirmOnOk = null;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v);
  }
  if (typeof children === 'string') {
    el.textContent = children;
  } else if (Array.isArray(children)) {
    children.forEach((c) => {
      if (c == null) return;
      if (typeof c === 'string') el.appendChild(document.createTextNode(c));
      else el.appendChild(c);
    });
  } else if (children) {
    el.appendChild(children);
  }
  return el;
}

function emptyState(emoji, title, subtitle) {
  return h('div', { class: 'empty-state' }, [
    h('div', { class: 'empty-state-emoji' }, emoji),
    h('div', { class: 'empty-state-title' }, title),
    h('div', {}, subtitle),
  ]);
}

function initialsOf(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatRelative(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return iso.slice(0, 10);
}

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m ${r}s`;
}

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(message, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4500);
}

// ------------------------------------------------------------------
// Knowledge Wiki view (Phase 1.5 chunk 8)
// ------------------------------------------------------------------

const wikiState = {
  pages: [],
  currentSlug: null,
  currentPage: null, // { frontmatter, body, backlinks }
  filter: 'all',
  search: '',
  ingesting: false,
  querying: false,
  linting: false,
};

function renderKnowledgeView(main) {
  // Trigger an async load + slug-map refresh, render skeleton synchronously.
  refreshKnowledgeState();
  fetch('/api/knowledge/pages')
    .then((r) => r.json())
    .then((data) => {
      wikiState.pages = data.pages || [];
      rerenderKnowledge();
    })
    .catch((err) => toast(`Failed to load wiki pages: ${err.message}`, 'error'));

  main.innerHTML = `
    <div class="view view-knowledge">
      <header class="view-header">
        <div>
          <h1>Knowledge</h1>
          <p class="view-sub">Karpathy-style LLM wiki — your advisors read it. <code>[[wikilinks]]</code> render as clickable links.</p>
        </div>
        <div class="view-actions">
          <input type="search" id="wiki-search" placeholder="Search slug / title / summary..." />
          <button class="btn-secondary" id="wiki-lint-btn">Lint</button>
          <button class="btn-primary" id="wiki-ingest-btn">+ Ingest</button>
        </div>
      </header>
      <div class="wiki-layout">
        <aside class="wiki-sidebar">
          <div class="wiki-filters">
            <button class="chip-filter active" data-filter="all">All</button>
            <button class="chip-filter" data-filter="concept">Concepts</button>
            <button class="chip-filter" data-filter="entity">Entities</button>
            <button class="chip-filter" data-filter="decision">Decisions</button>
            <button class="chip-filter" data-filter="source-summary">Sources</button>
            <button class="chip-filter" data-filter="comparison">Comparisons</button>
          </div>
          <div class="wiki-page-list" id="wiki-page-list">
            <div class="hint">Loading…</div>
          </div>
        </aside>
        <section class="wiki-detail" id="wiki-detail">
          <div class="wiki-detail-empty">
            <h2>Pick a page</h2>
            <p>Or run <code>aab knowledge query "..."</code> from the terminal, or click <strong>+ Ingest</strong> above.</p>
          </div>
        </section>
      </div>
      <div class="wiki-ingest-panel" id="wiki-ingest-panel" hidden>
        <div class="panel-header">
          <h2>Ingest</h2>
          <button class="icon-btn" id="wiki-ingest-close" aria-label="Close">×</button>
        </div>
        <div class="panel-body">
          <div class="field-group">
            <label class="field-label" for="wiki-ingest-paste">Paste markdown / text</label>
            <textarea id="wiki-ingest-paste" rows="8" placeholder="Drop any context, notes, or research here…"></textarea>
          </div>
          <div class="field-group">
            <label class="field-label" for="wiki-ingest-url">…or a URL</label>
            <input type="url" id="wiki-ingest-url" placeholder="https://example.com/article" />
          </div>
          <div class="panel-actions">
            <button class="btn-secondary" id="wiki-ingest-cancel">Cancel</button>
            <button class="btn-primary" id="wiki-ingest-go">Ingest</button>
          </div>
        </div>
      </div>
      <div class="wiki-query-bar">
        <input type="text" id="wiki-query-input" placeholder="Ask the wiki a question…" />
        <button class="btn-primary" id="wiki-query-go">Ask</button>
      </div>
      <div class="wiki-query-answer" id="wiki-query-answer" hidden></div>
    </div>
  `;
  // Wire events
  $('#wiki-search').addEventListener('input', (e) => {
    wikiState.search = e.target.value.trim().toLowerCase();
    rerenderKnowledge();
  });
  $$('.chip-filter').forEach((b) => {
    b.addEventListener('click', () => {
      $$('.chip-filter').forEach((x) => x.classList.toggle('active', x === b));
      wikiState.filter = b.dataset.filter;
      rerenderKnowledge();
    });
  });
  $('#wiki-ingest-btn').addEventListener('click', () => $('#wiki-ingest-panel').hidden = false);
  $('#wiki-ingest-close').addEventListener('click', () => $('#wiki-ingest-panel').hidden = true);
  $('#wiki-ingest-cancel').addEventListener('click', () => $('#wiki-ingest-panel').hidden = true);
  $('#wiki-ingest-go').addEventListener('click', () => doIngest());
  $('#wiki-lint-btn').addEventListener('click', () => doLint());
  $('#wiki-query-go').addEventListener('click', () => doQuery());
  $('#wiki-query-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doQuery(); });
}

function rerenderKnowledge() {
  const list = $('#wiki-page-list');
  if (!list) return;
  let pages = wikiState.pages;
  if (wikiState.filter !== 'all') {
    pages = pages.filter((p) => p.type === wikiState.filter);
  }
  if (wikiState.search) {
    pages = pages.filter((p) =>
      (p.slug || '').toLowerCase().includes(wikiState.search) ||
      (p.title || '').toLowerCase().includes(wikiState.search) ||
      (p.summary || '').toLowerCase().includes(wikiState.search)
    );
  }
  if (pages.length === 0) {
    list.innerHTML = '<div class="hint">No pages match. Try <strong>+ Ingest</strong> above.</div>';
    return;
  }
  list.innerHTML = pages
    .sort((a, b) => (a.slug || '').localeCompare(b.slug || ''))
    .map((p) => {
      const tag = p.userEdited ? '<span class="badge badge-warn">user-edited</span>' : '';
      const active = p.slug === wikiState.currentSlug ? ' active' : '';
      return `<button class="wiki-page-item${active}" data-slug="${escAttr(p.slug)}">
        <span class="wiki-page-type type-${p.type}">${escHtml(p.type || '?')}</span>
        <span class="wiki-page-slug">${escHtml(p.slug || '?')}</span>
        ${tag}
        ${p.summary ? `<span class="wiki-page-summary">${escHtml(truncate(p.summary, 80))}</span>` : ''}
      </button>`;
    })
    .join('');
  $$('.wiki-page-item', list).forEach((btn) => {
    btn.addEventListener('click', () => loadPage(btn.dataset.slug));
  });
}

function loadPage(slug) {
  wikiState.currentSlug = slug;
  rerenderKnowledge();
  const detail = $('#wiki-detail');
  detail.innerHTML = '<div class="hint">Loading…</div>';
  fetch(`/api/knowledge/pages/${encodeURIComponent(slug)}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        detail.innerHTML = `<div class="hint">${escHtml(data.error)}</div>`;
        return;
      }
      wikiState.currentPage = data;
      const fm = data.frontmatter || {};
      const bodyHtml = renderWikiBody(data.body || '');
      detail.innerHTML = `
        <header class="wiki-page-header">
          <h1>${escHtml(fm.title || data.slug)}</h1>
          <div class="wiki-page-meta">
            <span class="badge badge-type type-${escAttr(fm.type)}">${escHtml(fm.type || '')}</span>
            ${fm.confidence ? `<span class="badge">${escHtml(fm.confidence)} confidence</span>` : ''}
            ${fm.provenance ? `<span class="badge">${escHtml(fm.provenance)}</span>` : ''}
            ${fm.updated ? `<span class="hint">updated ${escHtml(fm.updated)}</span>` : ''}
          </div>
          ${fm.summary ? `<p class="wiki-page-summary-large">${escHtml(fm.summary)}</p>` : ''}
        </header>
        <div class="wiki-page-content">${bodyHtml}</div>
        ${renderSidecar(fm, data)}
      `;
      // Hook clicks on resolved wikilinks to load their page.
      $$('a.wiki-link', detail).forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const targetSlug = a.dataset.slug;
          if (targetSlug) loadPage(targetSlug);
        });
      });
      $$('span.wiki-unresolved', detail).forEach((s) => {
        s.addEventListener('click', () => {
          const slug = s.dataset.slug;
          if (!slug) return;
          $('#wiki-ingest-panel').hidden = false;
          $('#wiki-ingest-paste').value = `# ${slug.replace(/-/g, ' ')}\n\n(Filled in stub — replace with real content and click Ingest to create the page.)\n`;
          $('#wiki-ingest-paste').focus();
        });
      });
    })
    .catch((err) => {
      detail.innerHTML = `<div class="hint">Failed: ${escHtml(err.message)}</div>`;
    });
}

function renderSidecar(fm, data) {
  const out = [];
  out.push('<aside class="wiki-sidecar">');
  if (Array.isArray(fm.tags) && fm.tags.length > 0) {
    out.push('<section><h3>Tags</h3><div class="wiki-tag-row">');
    for (const t of fm.tags) out.push(`<span class="wiki-tag">${escHtml(t)}</span>`);
    out.push('</div></section>');
  }
  if (Array.isArray(fm.aliases) && fm.aliases.length > 0) {
    out.push('<section><h3>Aliases</h3><div class="wiki-tag-row">');
    for (const a of fm.aliases) out.push(`<span class="wiki-tag">${escHtml(a)}</span>`);
    out.push('</div></section>');
  }
  if (Array.isArray(fm.sources) && fm.sources.length > 0) {
    out.push('<section><h3>Sources</h3><ul class="wiki-source-list">');
    for (const s of fm.sources) out.push(`<li><code>${escHtml(s)}</code></li>`);
    out.push('</ul></section>');
  }
  if (Array.isArray(fm.related) && fm.related.length > 0) {
    out.push('<section><h3>Related</h3><div class="wiki-related">');
    for (const r of fm.related) {
      const html = rewriteWikiLinks(typeof r === 'string' ? r : String(r));
      out.push(`<div>${html}</div>`);
    }
    out.push('</div></section>');
  }
  if (data.backlinks) {
    out.push('<section><h3>Backlinks</h3><div class="wiki-backlinks">');
    out.push(rewriteWikiLinks(data.backlinks));
    out.push('</div></section>');
  }
  out.push('</aside>');
  return out.join('');
}

async function doIngest() {
  if (wikiState.ingesting) return;
  const paste = $('#wiki-ingest-paste').value.trim();
  const url = $('#wiki-ingest-url').value.trim();
  if (!paste && !url) {
    toast('Provide pasted text or a URL', 'error');
    return;
  }
  wikiState.ingesting = true;
  const btn = $('#wiki-ingest-go');
  btn.disabled = true;
  btn.textContent = 'Ingesting…';
  try {
    const res = await fetch('/api/knowledge/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(paste ? { paste } : { url }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const total = (data.producedPages?.length || 0) + (data.updatedPages?.length || 0);
    toast(`Ingest complete — ${total} pages touched`, 'ok');
    $('#wiki-ingest-panel').hidden = true;
    $('#wiki-ingest-paste').value = '';
    $('#wiki-ingest-url').value = '';
    await refreshKnowledgeState();
    const pages = await fetch('/api/knowledge/pages').then((r) => r.json());
    wikiState.pages = pages.pages || [];
    rerenderKnowledge();
  } catch (err) {
    toast(`Ingest failed: ${err.message}`, 'error');
  } finally {
    wikiState.ingesting = false;
    btn.disabled = false;
    btn.textContent = 'Ingest';
  }
}

async function doQuery() {
  if (wikiState.querying) return;
  const question = $('#wiki-query-input').value.trim();
  if (!question) return;
  wikiState.querying = true;
  const ans = $('#wiki-query-answer');
  ans.hidden = false;
  ans.innerHTML = '<div class="hint">Asking…</div>';
  try {
    const res = await fetch('/api/knowledge/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const citationsHtml = Array.isArray(data.citations) && data.citations.length > 0
      ? `<div class="wiki-citations">${data.citations.map((c) => `<a href="#" data-slug="${escAttr(c)}" class="wiki-link wiki-citation">[[${escHtml(c)}]]</a>`).join(' ')}</div>`
      : '';
    ans.innerHTML = `
      <div class="wiki-answer-body">${renderWikiBody(data.answer || '')}</div>
      ${citationsHtml}
      <div class="hint">cost: ${(data.costUsd || 0).toFixed(4)} USD</div>
    `;
    $$('.wiki-citation', ans).forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        loadPage(a.dataset.slug);
      });
    });
  } catch (err) {
    ans.innerHTML = `<div class="hint">Query failed: ${escHtml(err.message)}</div>`;
  } finally {
    wikiState.querying = false;
  }
}

async function doLint() {
  if (wikiState.linting) return;
  wikiState.linting = true;
  const btn = $('#wiki-lint-btn');
  btn.disabled = true;
  btn.textContent = 'Linting…';
  try {
    const res = await fetch('/api/knowledge/lint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runLlm: false }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const errs = (data.findings || []).filter((f) => f.severity === 'error').length;
    const warns = (data.findings || []).filter((f) => f.severity === 'warn').length;
    toast(`Lint complete — ${errs} errors, ${warns} warnings, slug-map refreshed`, errs > 0 ? 'warn' : 'ok');
  } catch (err) {
    toast(`Lint failed: ${err.message}`, 'error');
  } finally {
    wikiState.linting = false;
    btn.disabled = false;
    btn.textContent = 'Lint';
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}
function truncate(s, n) {
  const str = String(s ?? '');
  return str.length <= n ? str : str.slice(0, n - 1) + '…';
}

// Refresh slug-map on relevant WS events.
window.addEventListener('aab-wiki-event', (ev) => {
  if (!ev || !ev.detail) return;
  const t = ev.detail.type;
  if (t === 'wiki_ingest_done' || t === 'wiki_lint_done' || t === 'wiki_renamed') {
    refreshKnowledgeState();
    if (state.route === 'knowledge') {
      fetch('/api/knowledge/pages').then((r) => r.json()).then((data) => {
        wikiState.pages = data.pages || [];
        rerenderKnowledge();
      });
    }
  }
});

// ------------------------------------------------------------------
// Principle Explorer wizard
// ------------------------------------------------------------------

const EXPLORER_STEPS = ['behavior', 'antipattern', 'triggers', 'examples', 'priority'];
const STEP_LABELS = {
  behavior: 'Behavior',
  antipattern: 'Anti-pattern',
  triggers: 'Trigger questions',
  examples: 'Examples',
  priority: 'Priority',
};

const explorerState = {
  /** Working principle draft (mutated as we apply step values). */
  principle: null,
  /** Cross-step ExplorerTurn[] log. */
  history: [],
  /** Same-step turns (re-set when stepping). */
  currentStepTurns: [],
  step: 'behavior',
  isFirstMessage: true,
  pendingSuggested: null,
  /** id of the existing principle (when refining one) or null for new draft. */
  existingId: null,
};

function setupExplorerModal() {
  $('#explorer-modal-close').addEventListener('click', closeExplorerModal);
  $('#explorer-modal-skip').addEventListener('click', () => advanceExplorerStep({ skip: true }));
  $('#explorer-modal-next').addEventListener('click', () => advanceExplorerStep({}));
}

function openExplorerWizard(principle) {
  explorerState.principle = {
    id: principle?.id,
    title: principle?.title || '',
    description: principle?.description || '',
    category: principle?.category || 'meta',
    priority: principle?.priority ?? 5,
    behavior: principle?.behavior || '',
    antiPattern: principle?.antiPattern,
    triggerQuestions: principle?.triggerQuestions,
    examples: principle?.examples,
    isActive: principle?.isActive ?? true,
  };
  explorerState.history = [];
  explorerState.currentStepTurns = [];
  explorerState.step = 'behavior';
  explorerState.isFirstMessage = true;
  explorerState.pendingSuggested = null;
  explorerState.existingId = principle?.id || null;

  $('#explorer-modal-title').textContent =
    `Explore: ${explorerState.principle.title || '(new draft)'} — ${STEP_LABELS[explorerState.step]}`;
  $('#explorer-modal').hidden = false;
  $('#explorer-modal-next').hidden = true;
  renderExplorerStep();
  // Auto-fire the opener turn.
  fireExplorerStep('');
}

function closeExplorerModal() {
  $('#explorer-modal').hidden = true;
  $('#explorer-modal-body').innerHTML = '';
}

function renderExplorerStep() {
  const body = $('#explorer-modal-body');
  body.innerHTML = '';
  const wrap = h('div', { class: 'explorer-wrap', 'data-testid': `explorer-step-${explorerState.step}` });
  // Step indicator
  const steps = h('div', { class: 'explorer-steps' });
  for (const s of EXPLORER_STEPS) {
    const dot = h('span', { class: 'explorer-step-dot' + (s === explorerState.step ? ' active' : '') }, STEP_LABELS[s]);
    steps.appendChild(dot);
  }
  wrap.appendChild(steps);
  // Transcript
  const transcript = h('div', { class: 'explorer-transcript' });
  for (const turn of explorerState.currentStepTurns) {
    const div = h('div', { class: `explorer-msg ${turn.role}` });
    div.appendChild(h('span', { class: 'explorer-role' }, turn.role === 'user' ? 'you' : 'coach'));
    const content = h('div', { class: 'explorer-content' });
    content.textContent = turn.content;
    div.appendChild(content);
    transcript.appendChild(div);
  }
  wrap.appendChild(transcript);
  // Composer
  const composer = h('div', { class: 'explorer-composer' });
  const input = h('textarea', { rows: '3', placeholder: 'Type your answer…', 'data-testid': 'explorer-input' });
  const sendBtn = h('button', { class: 'btn-primary', 'data-testid': 'explorer-send' }, 'Send');
  sendBtn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) return;
    explorerState.currentStepTurns.push({ step: explorerState.step, role: 'user', content: text });
    explorerState.isFirstMessage = false;
    input.value = '';
    renderExplorerStep();
    fireExplorerStep(text);
  });
  composer.appendChild(input);
  composer.appendChild(sendBtn);
  wrap.appendChild(composer);
  body.appendChild(wrap);
  // Working draft summary
  const draft = h('div', { class: 'explorer-draft' });
  const p = explorerState.principle;
  const lines = [
    `Title: ${p.title}`,
    `Category: ${p.category}`,
    `Priority: ${p.priority}/10`,
    p.behavior ? `Behavior: ${truncateForExplorer(p.behavior, 100)}` : '',
    p.antiPattern ? `Anti-pattern: ${truncateForExplorer(p.antiPattern, 100)}` : '',
    Array.isArray(p.triggerQuestions) && p.triggerQuestions.length > 0 ? `Triggers: ${p.triggerQuestions.length} q` : '',
    Array.isArray(p.examples) && p.examples.length > 0 ? `Examples: ${p.examples.length}` : '',
  ].filter(Boolean);
  draft.innerHTML = `<strong>Working draft</strong><br>` + lines.map((l) => `<span>${escHtml(l)}</span>`).join('<br>');
  body.appendChild(draft);
}

function truncateForExplorer(s, max) {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

async function fireExplorerStep(userMessage) {
  const body = $('#explorer-modal-body');
  const thinking = h('div', { class: 'explorer-thinking' }, 'Coach thinking…');
  body.appendChild(thinking);
  try {
    const result = await fetchJSON('/api/principles/explore-step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principle: explorerState.principle,
        history: explorerState.history,
        step: explorerState.step,
        userMessage,
        isFirstMessage: explorerState.isFirstMessage,
      }),
    });
    explorerState.currentStepTurns.push({ step: explorerState.step, role: 'assistant', content: result.reply });
    explorerState.isFirstMessage = false;
    if (result.synthesised && result.suggested) {
      explorerState.pendingSuggested = result.suggested;
      $('#explorer-modal-next').hidden = false;
    }
    renderExplorerStep();
  } catch (e) {
    thinking.remove();
    toast('Coach failed: ' + e.message, 'err');
  }
}

async function advanceExplorerStep(opts) {
  // Apply the pending suggestion (if any and not skipped).
  if (!opts.skip && explorerState.pendingSuggested) {
    try {
      const r = await fetchJSON('/api/principles/apply-step', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          principle: explorerState.principle,
          step: explorerState.step,
          value: explorerState.pendingSuggested,
        }),
      });
      explorerState.principle = { ...explorerState.principle, ...r.principle };
    } catch (e) {
      toast('Apply failed: ' + e.message, 'err');
      return;
    }
  }
  // Move the same-step turns into the global history so the next step has them.
  explorerState.history = [...explorerState.history, ...explorerState.currentStepTurns];
  explorerState.currentStepTurns = [];
  explorerState.pendingSuggested = null;
  $('#explorer-modal-next').hidden = true;
  const idx = EXPLORER_STEPS.indexOf(explorerState.step);
  if (idx === EXPLORER_STEPS.length - 1) {
    // All steps done — save the principle.
    await saveExploredPrinciple();
    return;
  }
  explorerState.step = EXPLORER_STEPS[idx + 1];
  explorerState.isFirstMessage = true;
  $('#explorer-modal-title').textContent =
    `Explore: ${explorerState.principle.title || '(new draft)'} — ${STEP_LABELS[explorerState.step]}`;
  renderExplorerStep();
  fireExplorerStep('');
}

async function saveExploredPrinciple() {
  const p = explorerState.principle;
  try {
    if (explorerState.existingId) {
      await fetchJSON(`/api/principles/${explorerState.existingId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          behavior: p.behavior,
          antiPattern: p.antiPattern,
          triggerQuestions: p.triggerQuestions,
          examples: p.examples,
          priority: p.priority,
        }),
      });
      toast(`Saved refined principle "${p.title}".`, 'ok');
    } else {
      await fetchJSON('/api/principles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: p.title,
          description: p.description,
          category: p.category,
          behavior: p.behavior,
          antiPattern: p.antiPattern,
          triggerQuestions: p.triggerQuestions,
          examples: p.examples,
          priority: p.priority,
        }),
      });
      toast(`Created new principle "${p.title}".`, 'ok');
    }
    closeExplorerModal();
    await refreshState({ silent: true });
    if (state.route === 'principles') navigate('principles');
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  }
}

// ------------------------------------------------------------------
// Decision Coach view
// ------------------------------------------------------------------

const coachState = {
  sessions: [],
  currentSessionId: null,
  currentSession: null,
  thinking: false,
};

function renderCoachView(main) {
  const view = h('div', { class: 'view coach-view', 'data-testid': 'coach-view' });
  view.appendChild(
    h('div', { class: 'view-header' }, [
      h('div', {}, [
        h('div', { class: 'view-title' }, 'Decision Coach'),
        h('div', { class: 'view-subtitle' }, 'Principle-based decision conversations (Dalio-style).'),
      ]),
      (() => {
        const wrap = h('div', { class: 'header-actions' });
        const newBtn = h('button', { class: 'btn-primary', 'data-testid': 'coach-new-session-btn' }, '+ New session');
        newBtn.addEventListener('click', openNewCoachSessionModal);
        wrap.appendChild(newBtn);
        return wrap;
      })(),
    ]),
  );

  const body = h('div', { class: 'coach-layout' });
  const sidebar = h('aside', { class: 'coach-sidebar', 'data-testid': 'coach-session-list' });
  sidebar.appendChild(h('div', { class: 'coach-sidebar-head' }, 'Sessions'));
  const sidebarList = h('div', { class: 'coach-session-list' });
  sidebarList.id = 'coach-session-list';
  sidebar.appendChild(sidebarList);
  body.appendChild(sidebar);

  const detail = h('section', { class: 'coach-detail', id: 'coach-detail', 'data-testid': 'coach-detail' });
  detail.appendChild(h('div', { class: 'coach-empty' }, [
    h('h2', {}, 'Pick a session, or start a new one'),
    h('p', {}, 'The coach references your active principles to help you think through hard decisions.'),
  ]));
  body.appendChild(detail);
  view.appendChild(body);
  main.appendChild(view);

  refreshCoachSessions();
}

async function refreshCoachSessions() {
  try {
    const r = await fetchJSON('/api/coach/sessions');
    coachState.sessions = r.sessions || [];
    renderCoachSidebar();
  } catch (e) {
    toast('Could not load sessions: ' + e.message, 'err');
  }
}

function renderCoachSidebar() {
  const list = $('#coach-session-list');
  if (!list) return;
  list.innerHTML = '';
  if (coachState.sessions.length === 0) {
    list.appendChild(h('div', { class: 'hint' }, 'No sessions yet. Click "New session".'));
    return;
  }
  for (const s of coachState.sessions) {
    const row = h('button', {
      class: 'coach-session-row' + (s.id === coachState.currentSessionId ? ' active' : ''),
      'data-testid': 'coach-session-row',
      'data-session-id': s.id,
    });
    const title = s.title || s.situation.slice(0, 60);
    row.appendChild(h('div', { class: 'coach-session-title' }, title));
    const meta = h('div', { class: 'coach-session-meta' });
    meta.appendChild(h('span', {}, `${s.messages.length} msg`));
    meta.appendChild(h('span', {}, ' · '));
    meta.appendChild(h('span', {}, s.status));
    meta.appendChild(h('span', {}, ' · '));
    meta.appendChild(h('span', {}, formatRelative(s.updatedAt)));
    row.appendChild(meta);
    row.addEventListener('click', () => loadCoachSession(s.id));
    list.appendChild(row);
  }
}

async function loadCoachSession(id) {
  coachState.currentSessionId = id;
  renderCoachSidebar();
  const detail = $('#coach-detail');
  if (!detail) return;
  detail.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const session = await fetchJSON('/api/coach/sessions/' + encodeURIComponent(id));
    coachState.currentSession = session;
    renderCoachChat();
  } catch (e) {
    detail.innerHTML = `<div class="hint err">${escHtml(e.message)}</div>`;
  }
}

function renderCoachChat() {
  const detail = $('#coach-detail');
  if (!detail || !coachState.currentSession) return;
  const s = coachState.currentSession;
  detail.innerHTML = '';
  const head = h('div', { class: 'coach-chat-head' });
  head.appendChild(h('div', { class: 'coach-chat-title' }, s.title || 'Decision session'));
  head.appendChild(h('div', { class: 'coach-chat-situation' }, s.situation));
  const headRow = h('div', { class: 'coach-chat-meta' });
  headRow.appendChild(h('span', {}, s.status));
  headRow.appendChild(h('span', {}, ' · '));
  headRow.appendChild(h('span', {}, formatRelative(s.updatedAt)));
  headRow.appendChild(h('span', {}, ' · '));
  const delBtn = h('button', { class: 'btn-danger-ghost', 'data-testid': 'coach-delete-btn' }, 'Delete');
  delBtn.addEventListener('click', () =>
    openConfirmModal({
      title: 'Delete this coach session?',
      message: 'This cannot be undone.',
      okLabel: 'Delete',
      onOk: async () => {
        await fetchJSON('/api/coach/sessions/' + s.id, { method: 'DELETE' });
        toast('Session deleted.', 'ok');
        coachState.currentSession = null;
        coachState.currentSessionId = null;
        await refreshCoachSessions();
        renderCoachView($('#main'));
      },
    }),
  );
  headRow.appendChild(delBtn);
  head.appendChild(headRow);
  detail.appendChild(head);

  const stream = h('div', { class: 'coach-stream', 'data-testid': 'coach-stream' });
  for (const m of s.messages) {
    const bubble = h('div', { class: `coach-msg ${m.role}` });
    bubble.appendChild(h('span', { class: 'coach-role' }, m.role === 'user' ? 'you' : 'coach'));
    const body = h('div', { class: 'coach-msg-body' });
    body.textContent = m.content;
    bubble.appendChild(body);
    if (m.principlesReferenced && m.principlesReferenced.length > 0) {
      const refs = h('div', { class: 'coach-msg-refs' });
      const names = m.principlesReferenced
        .map((pid) => state.principles.find((p) => p.id === pid)?.title)
        .filter(Boolean);
      if (names.length > 0) {
        refs.textContent = 'principles: ' + names.join(', ');
        bubble.appendChild(refs);
      }
    }
    stream.appendChild(bubble);
  }
  if (coachState.thinking) {
    stream.appendChild(h('div', { class: 'coach-thinking' }, 'Coach thinking…'));
  }
  detail.appendChild(stream);

  const composer = h('div', { class: 'coach-composer' });
  const input = h('textarea', {
    rows: '2',
    placeholder: 'Type your message…',
    'data-testid': 'coach-input',
  });
  const sendBtn = h('button', { class: 'btn-primary', 'data-testid': 'coach-send-btn' }, 'Send');
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;
    coachState.thinking = true;
    renderCoachChat();
    try {
      await fetchJSON(`/api/coach/sessions/${s.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }),
      });
      // The actual reply arrives via WS coach_message.
    } catch (e) {
      coachState.thinking = false;
      toast('Send failed: ' + e.message, 'err');
      renderCoachChat();
    } finally {
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  });
  composer.appendChild(input);
  composer.appendChild(sendBtn);
  detail.appendChild(composer);

  // Auto-scroll to bottom
  stream.scrollTop = stream.scrollHeight;
}

function openNewCoachSessionModal() {
  $('#edit-modal-title').textContent = 'New coach session';
  const body = $('#edit-modal-body');
  body.innerHTML = '';
  const fields = {
    title: input('Title (optional)', '', 'e.g. Should I pivot?'),
    situation: textarea(
      'Situation / decision to think through',
      '',
      'Describe the decision and any constraints.',
      4,
    ),
  };
  body.appendChild(fields.title.wrap);
  body.appendChild(fields.situation.wrap);
  $('#edit-modal-delete').hidden = true;
  $('#edit-modal').hidden = false;
  fields.situation.input.focus();
  editModalOnSave = async () => {
    const situation = fields.situation.input.value.trim();
    if (!situation) {
      toast('Situation is required.', 'err');
      throw new Error('Situation is required.');
    }
    const r = await fetchJSON('/api/coach/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ situation, title: fields.title.input.value.trim() || undefined }),
    });
    toast('Session started — coach is opening the conversation.', 'ok');
    coachState.currentSessionId = r.session.id;
    coachState.currentSession = r.session;
    coachState.thinking = true;
    await refreshCoachSessions();
    if (state.route === 'coach') renderCoachChat();
  };
}

// WS bridge for coach events.
window.addEventListener('aab-coach-event', (ev) => {
  const d = ev.detail || {};
  if (d.type === 'coach_thinking') {
    if (coachState.currentSessionId === d.sessionId) {
      coachState.thinking = true;
      if (state.route === 'coach') renderCoachChat();
    }
  } else if (d.type === 'coach_message') {
    if (coachState.currentSessionId === d.sessionId && d.session) {
      coachState.currentSession = d.session;
      coachState.thinking = false;
      if (state.route === 'coach') renderCoachChat();
    }
    refreshCoachSessions();
  } else if (d.type === 'coach_error') {
    if (coachState.currentSessionId === d.sessionId) {
      coachState.thinking = false;
      toast('Coach error: ' + d.message, 'err');
      if (state.route === 'coach') renderCoachChat();
    }
  } else if (d.type === 'coach_session_started' || d.type === 'coach_session_deleted' || d.type === 'coach_session_updated') {
    refreshCoachSessions();
  }
});

// ==================================================================
// Sparring (Phase 3) — 1:1 deep dive panel anchored to a response
// ==================================================================

const sparringState = {
  open: false,
  session: null,
  member: null,
  discussion: null,
  thinking: false,
  activity: null,
};

async function openSparringPanel({ discussion, memberId, memberName, anchorRoundNumber, anchorTurnNumber }) {
  try {
    const res = await fetch(`/api/discussions/${encodeURIComponent(discussion.id)}/sparring`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, memberName, anchorRoundNumber, anchorTurnNumber }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Failed to open sparring (HTTP ${res.status})`);
    }
    const { session, reused } = await res.json();
    sparringState.open = true;
    sparringState.session = session;
    sparringState.member = state.members.find((m) => m.id === memberId) || { name: memberName };
    sparringState.discussion = discussion;
    sparringState.thinking = false;
    sparringState.activity = null;
    renderSparringModal();
    if (!reused) toast(`Sparring session opened with ${memberName}.`, 'ok');
  } catch (err) {
    toast(err.message || 'Could not open sparring', 'err');
  }
}

function renderSparringModal() {
  let modal = document.getElementById('sparring-modal');
  if (!modal) {
    modal = h('div', {
      class: 'modal-backdrop',
      id: 'sparring-modal',
      'data-testid': 'sparring-modal',
    });
    document.body.appendChild(modal);
  }
  modal.innerHTML = '';
  modal.hidden = !sparringState.open;
  if (!sparringState.open) return;

  const inner = h('div', { class: 'modal modal-wide sparring-modal' });

  const header = h('div', { class: 'modal-header' });
  const titleBlock = h('div', {}, [
    h('h2', { 'data-testid': 'sparring-title' }, `⚔ 1:1 with ${sparringState.member?.name || sparringState.session?.memberName}`),
    h(
      'div',
      { class: 'message-meta' },
      `Anchor: round ${sparringState.session.anchorRoundNumber} · turn ${sparringState.session.anchorTurnNumber}`,
    ),
  ]);
  header.appendChild(titleBlock);

  const headerActions = h('div', { class: 'spar-header-actions' });
  const injectBtn = h(
    'button',
    {
      class: 'btn-secondary',
      type: 'button',
      'data-testid': 'sparring-inject-btn',
      title: 'Write the latest reply back into the main discussion timeline',
    },
    '↩ Inject insight back',
  );
  injectBtn.addEventListener('click', openSparringInjectModal);
  headerActions.appendChild(injectBtn);

  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close', type: 'button' }, '×');
  closeBtn.addEventListener('click', closeSparringPanel);
  headerActions.appendChild(closeBtn);
  header.appendChild(headerActions);
  inner.appendChild(header);

  const body = h('div', { class: 'modal-body sparring-body' });

  // Sticky anchor banner
  const anchor = h('div', { class: 'sparring-anchor', 'data-testid': 'sparring-anchor' });
  anchor.appendChild(h('div', { class: 'sparring-anchor-label' }, 'Anchored response'));
  anchor.appendChild(h('div', { class: 'sparring-anchor-text' }, sparringState.session.anchorResponsePreview || ''));
  body.appendChild(anchor);

  // Transcript
  const transcript = h('div', { class: 'sparring-transcript', 'data-testid': 'sparring-transcript' });
  const messages = sparringState.session.messages || [];
  if (messages.length === 0) {
    transcript.appendChild(
      h('div', { class: 'message-meta sparring-empty' }, 'No messages yet — type your first sharper question below.'),
    );
  }
  for (const m of messages) {
    transcript.appendChild(sparringBubble(m, sparringState.member?.name || sparringState.session.memberName));
  }
  if (sparringState.thinking) {
    transcript.appendChild(sparringThinkingBubble(sparringState.member?.name || sparringState.session.memberName, sparringState.activity));
  }
  body.appendChild(transcript);

  // Composer
  const composer = h('div', { class: 'sparring-composer' });
  const textarea = h('textarea', {
    id: 'sparring-input',
    'data-testid': 'sparring-input',
    rows: '3',
    placeholder: 'Push back, ask a sharper question, request a counter-example…',
  });
  composer.appendChild(textarea);
  const composerActions = h('div', { class: 'chat-actions sparring-composer-actions' });
  const sendBtn = h(
    'button',
    { class: 'btn-primary', 'data-testid': 'sparring-send-btn', type: 'button' },
    '↳ Send',
  );
  sendBtn.addEventListener('click', () => sendSparringMessageFromUi(textarea));
  composerActions.appendChild(sendBtn);
  composer.appendChild(composerActions);

  // Ctrl/Cmd+Enter shortcut
  textarea.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      sendSparringMessageFromUi(textarea);
    }
  });

  body.appendChild(composer);

  inner.appendChild(body);
  modal.appendChild(inner);

  // Auto-scroll transcript to bottom
  setTimeout(() => {
    transcript.scrollTop = transcript.scrollHeight;
  }, 0);
}

function sparringBubble(message, memberName) {
  const isUser = message.role === 'user';
  const wrap = h('div', {
    class: 'message' + (isUser ? ' message-user' : ''),
    'data-testid': isUser ? 'sparring-msg-user' : 'sparring-msg-assistant',
  });
  if (!isUser) {
    const member = state.members.find((m) => m.id === sparringState.session.memberId) || { name: memberName };
    const color = member.color || colorForMember(memberName);
    wrap.appendChild(h('div', { class: 'avatar', 'data-color': color }, initialsOf(memberName)));
  }
  const body = h('div', { class: 'message-body' + (isUser ? ' user-body' : '') });
  body.appendChild(h('div', { class: 'message-name' }, isUser ? 'You' : memberName));
  body.appendChild(h('div', { class: 'bubble' + (isUser ? ' user-bubble' : '') }, message.content));
  if (!isUser && Array.isArray(message.sources) && message.sources.length > 0) {
    const sources = h('div', { class: 'sparring-sources' });
    sources.appendChild(h('div', { class: 'struct-section-title' }, 'Sources'));
    const ul = h('ul');
    for (const s of message.sources) {
      const li = h('li', {});
      const link = h('a', { href: s.url, target: '_blank', rel: 'noreferrer noopener' }, s.title || s.url);
      li.appendChild(link);
      ul.appendChild(li);
    }
    sources.appendChild(ul);
    body.appendChild(sources);
  }
  wrap.appendChild(body);
  if (isUser) {
    wrap.appendChild(h('div', { class: 'avatar avatar-user', 'data-color': 'brand' }, '👤'));
  }
  return wrap;
}

function sparringThinkingBubble(memberName, activity) {
  const member = state.members.find((m) => m.id === sparringState.session.memberId) || { name: memberName };
  const color = member.color || colorForMember(memberName);
  const wrap = h('div', { class: 'message', 'data-testid': 'sparring-typing' });
  wrap.appendChild(h('div', { class: 'avatar', 'data-color': color }, initialsOf(memberName)));
  const body = h('div', { class: 'message-body' });
  body.appendChild(h('div', { class: 'message-name' }, memberName));
  const bubble = h('div', { class: 'typing-bubble' });
  bubble.appendChild(h('span', { class: 'typing-activity' }, (activity || 'thinking').replace(/[.…]+$/, '')));
  const dots = h('div', { class: 'typing' });
  dots.appendChild(h('span'));
  dots.appendChild(h('span'));
  dots.appendChild(h('span'));
  bubble.appendChild(dots);
  body.appendChild(bubble);
  wrap.appendChild(body);
  return wrap;
}

async function sendSparringMessageFromUi(textarea) {
  const content = (textarea.value || '').trim();
  if (!content) {
    toast('Type a message first.', 'err');
    return;
  }
  if (!sparringState.session) return;
  textarea.value = '';
  // Optimistic: append user message into local state, mark thinking.
  sparringState.session.messages.push({
    id: 'pending-' + Date.now(),
    sessionId: sparringState.session.id,
    role: 'user',
    content,
    sources: [],
    createdAt: new Date().toISOString(),
  });
  sparringState.thinking = true;
  sparringState.activity = null;
  renderSparringModal();
  try {
    const res = await fetch(`/api/sparring/${encodeURIComponent(sparringState.session.id)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (res.status !== 202) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
  } catch (err) {
    sparringState.thinking = false;
    toast(err.message || 'Send failed', 'err');
    renderSparringModal();
  }
}

function closeSparringPanel() {
  sparringState.open = false;
  sparringState.session = null;
  sparringState.member = null;
  sparringState.discussion = null;
  sparringState.thinking = false;
  sparringState.activity = null;
  renderSparringModal();
}

function openSparringInjectModal() {
  if (!sparringState.session) return;
  const lastAssistant = [...sparringState.session.messages].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) {
    toast('Send a message and get a reply first — there is nothing to inject.', 'err');
    return;
  }
  const insight = lastAssistant.content;
  let modal = document.getElementById('sparring-inject-modal');
  if (!modal) {
    modal = h('div', {
      class: 'modal-backdrop',
      id: 'sparring-inject-modal',
      'data-testid': 'sparring-inject-modal',
    });
    document.body.appendChild(modal);
  }
  modal.innerHTML = '';
  modal.hidden = false;
  const inner = h('div', { class: 'modal modal-wide' });
  inner.appendChild(
    (() => {
      const head = h('div', { class: 'modal-header' });
      head.appendChild(h('h2', {}, '↩ Inject insight back to discussion'));
      const close = h('button', { class: 'icon-btn', 'aria-label': 'Close', type: 'button' }, '×');
      close.addEventListener('click', () => (modal.hidden = true));
      head.appendChild(close);
      return head;
    })(),
  );
  const body = h('div', { class: 'modal-body' });
  body.appendChild(
    h(
      'div',
      { class: 'message-meta' },
      `Will land in discussion at round ${sparringState.session.anchorRoundNumber} as a sparring_injection user response.`,
    ),
  );
  body.appendChild(h('label', { class: 'field-label', for: 'sparring-inject-text' }, 'Insight text (editable)'));
  const ta = h(
    'textarea',
    {
      id: 'sparring-inject-text',
      'data-testid': 'sparring-inject-textarea',
      rows: '8',
    },
    insight,
  );
  body.appendChild(ta);
  inner.appendChild(body);

  const footer = h('div', { class: 'modal-footer' });
  const cancel = h('button', { class: 'btn-secondary', type: 'button' }, 'Cancel');
  cancel.addEventListener('click', () => (modal.hidden = true));
  footer.appendChild(cancel);
  const confirm = h(
    'button',
    { class: 'btn-primary', type: 'button', 'data-testid': 'sparring-inject-confirm' },
    '↩ Inject',
  );
  confirm.addEventListener('click', async () => {
    const text = (ta.value || '').trim();
    if (!text) {
      toast('Insight cannot be empty.', 'err');
      return;
    }
    try {
      const res = await fetch(`/api/sparring/${encodeURIComponent(sparringState.session.id)}/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ insight: text }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const { discussion } = await res.json();
      modal.hidden = true;
      toast('Insight injected into the main discussion.', 'ok');
      // Refresh the underlying discussion if the user still has it open in the
      // background.
      if (state.currentDiscussion && state.currentDiscussion.id === discussion.id) {
        state.currentDiscussion = discussion;
        updateDiscussionList(discussion);
        if (state.route === 'discussions') {
          openChatView(discussion);
        }
      }
    } catch (err) {
      toast(err.message || 'Inject failed', 'err');
    }
  });
  footer.appendChild(confirm);
  inner.appendChild(footer);

  modal.appendChild(inner);
}

async function openSparringListModal(discussion) {
  let sessions = [];
  try {
    const res = await fetch(`/api/discussions/${encodeURIComponent(discussion.id)}/sparring`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    sessions = body.sessions || [];
  } catch (err) {
    toast('Could not load sparring sessions: ' + err.message, 'err');
    return;
  }

  let modal = document.getElementById('sparring-list-modal');
  if (!modal) {
    modal = h('div', {
      class: 'modal-backdrop',
      id: 'sparring-list-modal',
      'data-testid': 'sparring-list-modal',
    });
    document.body.appendChild(modal);
  }
  modal.innerHTML = '';
  modal.hidden = false;

  const inner = h('div', { class: 'modal modal-wide' });

  const header = h('div', { class: 'modal-header' });
  header.appendChild(h('h2', {}, `⚔ Sparring sessions · ${sessions.length}`));
  const close = h('button', { class: 'icon-btn', 'aria-label': 'Close', type: 'button' }, '×');
  close.addEventListener('click', () => (modal.hidden = true));
  header.appendChild(close);
  inner.appendChild(header);

  const body = h('div', { class: 'modal-body' });
  if (sessions.length === 0) {
    body.appendChild(
      h(
        'div',
        { class: 'message-meta' },
        'No sparring sessions yet. Click ⚔ Spar on any response in the chat to start one.',
      ),
    );
  } else {
    const list = h('div', { class: 'sparring-session-list', 'data-testid': 'sparring-session-list' });
    for (const s of sessions) {
      const row = h('button', {
        class: 'sparring-session-row',
        type: 'button',
        'data-testid': 'sparring-session-row',
        'data-session-id': s.id,
      });
      row.appendChild(h('div', { class: 'spar-row-title' }, `${s.memberName} · round ${s.anchorRoundNumber} · turn ${s.anchorTurnNumber}`));
      row.appendChild(
        h(
          'div',
          { class: 'spar-row-meta' },
          `${s.messages?.length || 0} message${(s.messages?.length || 0) === 1 ? '' : 's'} · ${formatRelative(s.updatedAt)}`,
        ),
      );
      if (s.title) row.appendChild(h('div', { class: 'spar-row-subtitle' }, s.title));
      row.addEventListener('click', () => {
        modal.hidden = true;
        sparringState.open = true;
        sparringState.session = s;
        sparringState.member = state.members.find((m) => m.id === s.memberId) || { name: s.memberName };
        sparringState.discussion = discussion;
        sparringState.thinking = false;
        sparringState.activity = null;
        renderSparringModal();
      });
      list.appendChild(row);
    }
    body.appendChild(list);
  }
  inner.appendChild(body);

  modal.appendChild(inner);
}

window.addEventListener('aab-sparring-event', (ev) => {
  const d = ev.detail;
  if (!d || !sparringState.session || d.sessionId !== sparringState.session.id) return;
  if (d.type === 'sparring_thinking') {
    sparringState.thinking = true;
    sparringState.activity = null;
    renderSparringModal();
  } else if (d.type === 'sparring_activity') {
    sparringState.thinking = true;
    sparringState.activity = d.activity;
    renderSparringModal();
  } else if (d.type === 'sparring_message') {
    sparringState.thinking = false;
    sparringState.activity = null;
    if (d.session) {
      sparringState.session = d.session;
    } else {
      // Append the message into the optimistic transcript.
      sparringState.session.messages = sparringState.session.messages.filter((m) => !m.id.startsWith('pending-'));
      sparringState.session.messages.push(d.message);
    }
    renderSparringModal();
  } else if (d.type === 'sparring_error') {
    sparringState.thinking = false;
    sparringState.activity = null;
    toast('Sparring error: ' + d.message, 'err');
    renderSparringModal();
  } else if (d.type === 'sparring_session_deleted') {
    closeSparringPanel();
  }
});

// ------------------------------------------------------------------
// Phase 5 — Skill Planner + skill-creator orchestration (client-side)
// ------------------------------------------------------------------

const plannerState = {
  planId: null,
  runId: null,
  action: null,
  proposal: null, // SkillDesignProposal
  phases: { 'pc-scan': 'queued', 'wiki': 'queued', 'web': 'queued', 'reasoning': 'queued' },
  stream: [],
};

function launchSkillPlan(action) {
  resetPlannerState(action);
  showPlannerProgress();
  fetchJSON(`/api/actions/${action.id}/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plannerTier: 'maximalist' }),
  }).then((res) => {
    plannerState.planId = res.planId;
  }).catch((err) => {
    toast('Plan failed: ' + err.message, 'err');
    hidePlannerProgress();
  });
}

function launchSkillSolve(action) {
  // Two-step UX: open Plan first; let the user accept; the Accept handler kicks off /solve.
  launchSkillPlan(action);
}

function resetPlannerState(action) {
  plannerState.planId = null;
  plannerState.runId = null;
  plannerState.action = action;
  plannerState.proposal = null;
  plannerState.phases = { 'pc-scan': 'queued', 'wiki': 'queued', 'web': 'queued', 'reasoning': 'queued' };
  plannerState.stream = [];
}

function showPlannerProgress() {
  const m = document.getElementById('planner-progress-modal');
  m.hidden = false;
  document.getElementById('planner-progress-title').textContent =
    'Skill Planner — ' + (plannerState.action?.title ?? '');
  // Clear any stale error banner from a prior run.
  const banner = document.getElementById('planner-error-banner');
  if (banner) banner.remove();
  paintPlannerPhases();
}

function hidePlannerProgress() {
  document.getElementById('planner-progress-modal').hidden = true;
}

function paintPlannerPhases() {
  const phases = document.querySelectorAll('#planner-progress-body .planner-phase');
  const keys = ['pc-scan', 'wiki', 'web', 'reasoning'];
  phases.forEach((node, i) => {
    const key = keys[i];
    const status = plannerState.phases[key] ?? 'queued';
    node.dataset.status = status;
    const statusNode = node.querySelector('.planner-phase-status');
    if (statusNode) statusNode.textContent = status;
  });
  const stream = document.getElementById('planner-stream');
  if (stream) {
    stream.innerHTML = '';
    for (const line of plannerState.stream.slice(-20)) {
      const row = document.createElement('div');
      row.className = 'planner-stream-row';
      row.textContent = line;
      stream.appendChild(row);
    }
  }
}

function showProposalModal(proposal) {
  plannerState.proposal = proposal;
  const m = document.getElementById('planner-proposal-modal');
  m.hidden = false;
  const title = m.querySelector('[data-testid="proposal-skill-name"]');
  if (title) title.textContent = 'Proposal: ' + proposal.skillName;
  const body = document.getElementById('planner-proposal-body');
  body.innerHTML = '';
  body.appendChild(renderProposalContent(proposal));
}

function hideProposalModal() {
  document.getElementById('planner-proposal-modal').hidden = true;
}

function renderProposalContent(proposal) {
  const wrap = document.createElement('div');
  wrap.className = 'planner-proposal';

  const summary = document.createElement('p');
  summary.innerHTML = `<strong>${escapeHtml(proposal.skillSummary)}</strong>`;
  wrap.appendChild(summary);

  // Tier radio
  const tierRow = document.createElement('div');
  tierRow.className = 'planner-tier-row';
  tierRow.dataset.testid = 'proposal-tier-radio';
  for (const t of ['minimal', 'standard', 'maximalist']) {
    const label = document.createElement('label');
    label.className = 'planner-tier-label';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'planner-tier';
    radio.value = t;
    if (t === (proposal.recommendedTier === 'custom' ? 'maximalist' : proposal.recommendedTier)) radio.checked = true;
    label.appendChild(radio);
    label.appendChild(document.createTextNode(' ' + t));
    tierRow.appendChild(label);
  }
  wrap.appendChild(tierRow);

  // Value rationale
  if (proposal.valueRationale) {
    const r = document.createElement('p');
    r.className = 'planner-rationale';
    r.textContent = proposal.valueRationale;
    wrap.appendChild(r);
  }

  // Integrations table
  const intTitle = document.createElement('h3');
  intTitle.textContent = `Integrations (${proposal.integrations.length})`;
  wrap.appendChild(intTitle);
  for (const integration of proposal.integrations) {
    const row = document.createElement('div');
    row.className = 'planner-integration-row';
    row.dataset.testid = 'proposal-integration-row';
    row.dataset.integrationId = integration.id;
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = true;
    toggle.dataset.testid = 'proposal-integration-toggle';
    toggle.dataset.integrationId = integration.id;
    const label = document.createElement('span');
    label.innerHTML = `<strong>${escapeHtml(integration.name)}</strong> ` +
      `<span class="planner-kind">${escapeHtml(integration.invocationHint?.kind ?? '?')}</span>` +
      (integration.purpose ? ` — ${escapeHtml(integration.purpose)}` : '');
    row.appendChild(toggle);
    row.appendChild(label);
    wrap.appendChild(row);
  }

  // Stakeholders
  const stakeholders = proposal.stakeholderTouchpoints ?? [];
  if (stakeholders.length > 0) {
    const sh = document.createElement('h3');
    sh.textContent = 'Stakeholders';
    wrap.appendChild(sh);
    for (const s of stakeholders) {
      const row = document.createElement('div');
      row.className = 'planner-stakeholder-row';
      row.dataset.testid = 'proposal-stakeholder-row';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = true;
      toggle.dataset.stakeholderName = s.name;
      const label = document.createElement('span');
      label.innerHTML = `<strong>${escapeHtml(s.name)}</strong> (${escapeHtml(s.role ?? '?')}) — ${escapeHtml(s.touchpointKind ?? 'other')}, produces: ${escapeHtml(s.produces ?? '?')}`;
      row.appendChild(toggle);
      row.appendChild(label);
      wrap.appendChild(row);
    }
  }

  // Narrative editor
  const ne = document.createElement('div');
  ne.style.marginTop = '12px';
  const neLabel = document.createElement('label');
  neLabel.className = 'field-label';
  neLabel.textContent = 'Narrative edits (optional)';
  ne.appendChild(neLabel);
  const neTextarea = document.createElement('textarea');
  neTextarea.dataset.testid = 'proposal-narrative-editor';
  neTextarea.id = 'proposal-narrative-editor';
  neTextarea.rows = 4;
  ne.appendChild(neTextarea);
  wrap.appendChild(ne);

  // Cost line
  if (typeof proposal.estimatedCostUsd === 'number') {
    const cost = document.createElement('p');
    cost.className = 'planner-cost';
    cost.textContent = `Estimated cost: $${proposal.estimatedCostUsd.toFixed(2)} · ~${Math.round(proposal.estimatedDurationMinutes ?? 0)} min`;
    wrap.appendChild(cost);
  }

  return wrap;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Wire planner modal buttons (once at boot).
window.addEventListener('DOMContentLoaded', () => {
  const close = document.getElementById('planner-progress-close');
  if (close) close.addEventListener('click', hidePlannerProgress);
  const pclose = document.getElementById('planner-proposal-close');
  if (pclose) pclose.addEventListener('click', hideProposalModal);
  const reject = document.getElementById('proposal-reject-btn');
  if (reject) reject.addEventListener('click', hideProposalModal);
  const accept = document.getElementById('proposal-accept-btn');
  if (accept) accept.addEventListener('click', acceptProposalAndSolve);
  const exportBtn = document.getElementById('proposal-export-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportProposalMarkdown);
  const replan = document.getElementById('proposal-replan-btn');
  if (replan) replan.addEventListener('click', () => {
    document.getElementById('replan-feedback-modal').hidden = false;
  });
  const replanCancel = document.getElementById('replan-feedback-cancel');
  if (replanCancel) replanCancel.addEventListener('click', () => {
    document.getElementById('replan-feedback-modal').hidden = true;
  });
  const replanClose = document.getElementById('replan-feedback-close');
  if (replanClose) replanClose.addEventListener('click', () => {
    document.getElementById('replan-feedback-modal').hidden = true;
  });
  const replanSubmit = document.getElementById('replan-feedback-submit');
  if (replanSubmit) replanSubmit.addEventListener('click', submitReplan);
  const runDetailClose = document.getElementById('run-detail-close');
  if (runDetailClose) runDetailClose.addEventListener('click', () => {
    document.getElementById('run-detail-modal').hidden = true;
  });
});

function acceptProposalAndSolve() {
  if (!plannerState.action || !plannerState.planId || !plannerState.proposal) return;
  hideProposalModal();
  toast('Starting skill-creator…', 'ok');
  fetchJSON(`/api/actions/${plannerState.action.id}/solve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plannerState.planId }),
  }).then((res) => {
    plannerState.runId = res.runId;
  }).catch((err) => {
    toast('Solve failed: ' + err.message, 'err');
  });
}

function exportProposalMarkdown() {
  if (!plannerState.planId) return;
  window.open(`/api/plans/${plannerState.planId}?as=md`, '_blank');
}

function submitReplan() {
  const input = document.getElementById('replan-feedback-input');
  const feedback = (input.value || '').trim();
  if (feedback.length < 10) {
    toast('Feedback must be at least 10 characters.', 'err');
    return;
  }
  if (!plannerState.planId || !plannerState.action) return;
  document.getElementById('replan-feedback-modal').hidden = true;
  toast('Re-planning with feedback…', 'ok');
  fetchJSON(`/api/plans/${plannerState.planId}/replan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feedback, actionId: plannerState.action.id }),
  }).then((res) => {
    plannerState.planId = res.planId;
    plannerState.phases.reasoning = 'running';
    paintPlannerPhases();
    showPlannerProgress();
  }).catch((err) => {
    toast('Re-plan failed: ' + err.message, 'err');
  });
}

window.addEventListener('aab-planner-event', (ev) => {
  const d = ev.detail;
  if (d.type === 'planner_recon_progress') {
    const phase = d.phase ?? d.payload?.phase;
    if (phase === 'pc-scan') plannerState.phases['pc-scan'] = 'done';
    if (phase === 'wiki-recon') plannerState.phases['wiki'] = 'done';
    if (phase === 'web-research') plannerState.phases['web'] = 'done';
    if (d.summary) plannerState.stream.push(`${phase}: ${d.summary}`);
    paintPlannerPhases();
  } else if (d.type === 'planner_recon_done') {
    plannerState.phases['pc-scan'] = 'done';
    plannerState.phases['wiki'] = 'done';
    plannerState.phases['web'] = 'done';
    plannerState.phases['reasoning'] = 'running';
    paintPlannerPhases();
  } else if (d.type === 'planner_reasoning_started') {
    plannerState.phases['reasoning'] = 'running';
    paintPlannerPhases();
  } else if (d.type === 'planner_proposal_ready') {
    plannerState.phases['reasoning'] = 'done';
    paintPlannerPhases();
    if (d.proposal) {
      hidePlannerProgress();
      showProposalModal(d.proposal);
    } else {
      // Server fired proposal_ready without a payload — keep progress pane
      // open so the user sees the failure (and not just a vanished modal).
      showPlannerError('Planner emitted an empty proposal (server bug). Re-run or contact support.');
    }
  } else if (d.type === 'planner_failed') {
    // Persistent failure banner inside the still-open progress pane — toast
    // alone disappears in 4.5s and after a 10min Opus run the user has no
    // proof anything happened. Caught via the 2026-05-21 live MCP smoke.
    plannerState.phases['reasoning'] = 'failed';
    paintPlannerPhases();
    showPlannerError(d.errorMessage ?? d.reason ?? 'Planner failed (no detail)');
    toast('Planner failed: ' + (d.errorMessage ?? 'unknown'), 'err');
  } else if (d.type === 'skill_run_started') {
    toast('skill-creator authoring…', 'ok');
  } else if (d.type === 'skill_run_tool_call') {
    plannerState.stream.push(`tool: ${d.tool ?? '?'}`);
    paintPlannerPhases();
  } else if (d.type === 'skill_run_installed') {
    toast('Skill installed at ' + (d.installPath ?? '?'), 'ok');
    refreshState({ silent: true }).then(() => { if (state.route === 'actions') navigate('actions'); });
  } else if (d.type === 'skill_run_failed') {
    showPlannerError('skill-creator failed: ' + (d.errorMessage ?? 'unknown'));
    toast('skill-creator failed: ' + (d.errorMessage ?? 'unknown'), 'err');
  }
});

function showPlannerError(message) {
  // Keep the progress pane visible with a sticky red banner so the user
  // doesn't lose context after a long-running failure.
  const m = document.getElementById('planner-progress-modal');
  if (m) m.hidden = false;
  const body = document.getElementById('planner-progress-body');
  if (!body) return;
  let banner = document.getElementById('planner-error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'planner-error-banner';
    banner.className = 'planner-error-banner';
    banner.dataset.testid = 'planner-error-banner';
    body.appendChild(banner);
  }
  banner.textContent = '✗ ' + message;
}

// ------------------------------------------------------------------
// Phase 5 — Skills tab
// ------------------------------------------------------------------

function renderSkillsView(main) {
  main.innerHTML = '';
  const header = h('div', { class: 'view-header' }, [
    h('h1', {}, 'Skills'),
    h('p', { class: 'view-sub' }, 'Installed Claude Code skills — project + user + plugin scope.'),
  ]);
  main.appendChild(header);
  const body = h('div', { class: 'skills-view', 'data-testid': 'skills-tab' });
  main.appendChild(body);
  fetchJSON('/api/skills').then((res) => {
    if (!res.skills || res.skills.length === 0) {
      body.innerHTML = '<p class="view-empty">No installed skills yet. Run <code>aab actions solve &lt;id&gt;</code> to ship one.</p>';
      return;
    }
    const list = h('div', { class: 'skills-list', 'data-testid': 'skills-list' });
    for (const s of res.skills) {
      const row = h('div', { class: 'skills-row', 'data-skill-name': s.name });
      row.appendChild(h('div', { class: 'skills-name' }, [
        h('strong', {}, s.name),
        h('span', { class: 'skills-scope' }, ` (${s.scope}${s.version ? '; v' + s.version : ''})`),
      ]));
      row.appendChild(h('div', { class: 'skills-dir' }, s.dir));
      const actions = h('div', { class: 'skills-actions' });
      const showBtn = h('button', { class: 'btn-secondary', 'data-testid': 'skill-show-btn' }, '👁 Show');
      showBtn.addEventListener('click', () => showSkillDetail(s.name));
      const testBtn = h('button', { class: 'btn-secondary', 'data-testid': 'skill-test-btn' }, '🧪 Test');
      testBtn.addEventListener('click', () => {
        const input = prompt(`Test ${s.name} — what prompt should we send?`, `Activate ${s.name}.`);
        if (input) testSkill(s.name, input);
      });
      actions.appendChild(showBtn);
      actions.appendChild(testBtn);
      row.appendChild(actions);
      list.appendChild(row);
    }
    body.appendChild(list);
  }).catch((err) => {
    body.innerHTML = '<p class="view-empty">Failed to load skills: ' + escapeHtml(err.message) + '</p>';
  });
}

function showSkillDetail(name) {
  fetchJSON(`/api/skills/${encodeURIComponent(name)}`).then((res) => {
    const modal = document.getElementById('run-detail-modal');
    document.getElementById('run-detail-title').textContent = `Skill — ${name}`;
    const body = document.getElementById('run-detail-body');
    body.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'skill-detail-body';
    pre.textContent = res.body;
    body.appendChild(pre);
    modal.hidden = false;
  }).catch((err) => toast('Show failed: ' + err.message, 'err'));
}

function testSkill(name, input) {
  toast(`Testing skill ${name} (this may take a minute)…`, 'ok');
  // We surface the test via a CLI call from the user's terminal — the GUI
  // shows a copy-able command for now (live in-browser execution is gated
  // behind a longer-running endpoint we'll add later).
  navigator.clipboard?.writeText(`aab skills test ${name} "${input.replace(/"/g, '\\"')}"`).then(
    () => toast('Copied `aab skills test` command to clipboard', 'ok'),
    () => toast('Run: aab skills test ' + name + ' "' + input + '"', 'ok'),
  );
}

// ------------------------------------------------------------------
// Go
// ------------------------------------------------------------------

bootstrap();
