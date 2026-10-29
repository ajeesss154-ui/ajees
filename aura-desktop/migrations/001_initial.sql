CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL, name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_settings (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 memory_enabled boolean NOT NULL DEFAULT true, theme text NOT NULL DEFAULT 'system',
 timezone text NOT NULL DEFAULT 'UTC', notifications_enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY,count integer NOT NULL,window_start timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name text NOT NULL,description text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS notes (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL,content text NOT NULL DEFAULT '',project_id uuid,tags jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id),FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id)
);
CREATE INDEX IF NOT EXISTS notes_search_idx ON notes USING gin(to_tsvector('english',title||' '||content));
CREATE TABLE IF NOT EXISTS tasks (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL,body text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
 priority text NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),due_at timestamptz,remind_at timestamptz,project_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id),FOREIGN KEY(project_id,user_id) REFERENCES projects(id,user_id)
);
CREATE INDEX IF NOT EXISTS tasks_user_due_idx ON tasks(user_id,due_at);
CREATE TABLE IF NOT EXISTS reminders (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,task_id uuid,
 title text NOT NULL,scheduled_at timestamptz NOT NULL,channel text NOT NULL DEFAULT 'in_app',status text NOT NULL DEFAULT 'pending',
 delivered_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(task_id,user_id) REFERENCES tasks(id,user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(status,scheduled_at);
CREATE TABLE IF NOT EXISTS notifications (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 reminder_id uuid UNIQUE REFERENCES reminders(id) ON DELETE CASCADE,title text NOT NULL,body text NOT NULL DEFAULT '',
 read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memories (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,
 content text NOT NULL,kind text NOT NULL DEFAULT 'fact' CHECK(kind IN ('fact','preference','goal','context')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id)
);
CREATE INDEX IF NOT EXISTS memories_search_idx ON memories USING gin(to_tsvector('english',title||' '||content));
CREATE TABLE IF NOT EXISTS conversations (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS messages (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,conversation_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('user','assistant','system','tool')),content text NOT NULL,
 sources jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(user_id,conversation_id,created_at);
CREATE TABLE IF NOT EXISTS documents (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,title text NOT NULL,
 filename text NOT NULL,mime_type text NOT NULL,size_bytes integer NOT NULL,content text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS document_chunks (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,document_id uuid NOT NULL,
 chunk_index integer NOT NULL,content text NOT NULL,page integer,
 FOREIGN KEY(document_id,user_id) REFERENCES documents(id,user_id) ON DELETE CASCADE,
 UNIQUE(document_id,chunk_index)
);
CREATE INDEX IF NOT EXISTS chunks_search_idx ON document_chunks USING gin(to_tsvector('english',content));
CREATE TABLE IF NOT EXISTS integrations (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider text NOT NULL,
 status text NOT NULL DEFAULT 'disconnected',scopes jsonb NOT NULL DEFAULT '[]',credentials_encrypted text,
 access_token_encrypted text,refresh_token_encrypted text,expires_at timestamptz,metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,provider)
);
CREATE TABLE IF NOT EXISTS oauth_states (
 id text PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider text NOT NULL,
 code_verifier text NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS approval_requests (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,conversation_id uuid NOT NULL,
 tool_name text NOT NULL,input jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',expires_at timestamptz NOT NULL,
 result jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS tool_executions (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,conversation_id uuid,
 tool_name text NOT NULL,input jsonb NOT NULL,output jsonb,status text NOT NULL,error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,user_id) REFERENCES conversations(id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_logs (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,action text NOT NULL,
 entity_type text NOT NULL,entity_id text,metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_logs(user_id,created_at);
