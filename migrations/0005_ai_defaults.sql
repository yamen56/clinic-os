alter table ai_agents alter column model set default 'claude-opus-5';
update ai_agents set model = 'claude-opus-5' where model = 'claude-sonnet-5';

-- Escalation + handoff bookkeeping for the AI receptionist
alter table ai_conversation_state add column last_ai_message_at timestamptz;
alter table ai_agents add column greeting text not null default '';
