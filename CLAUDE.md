# Pi5 Project - Claude Development Configuration

## Project Structure
- `frontend/` - React 19 + Vite 8 + TypeScript (SPA)
- `backend/` - Express 5 + TypeScript + SQLite (API server)
- `core/` - Shared utilities and types
- `Skills/` - Custom skill definitions

## Development Commands
- **Frontend dev**: `cd frontend && npm run dev`
- **Backend dev**: `cd backend && npm run dev`
- **Frontend build**: `cd frontend && npm run build`
- **Backend build**: `cd backend && npm run build`

## Agent & Sub-Agent Configuration

### Multi-Agent Mode
- Use parallel agents for independent tasks (frontend + backend simultaneously)
- Use background agents for long-running tasks (builds, tests)
- Dispatch sub-agents for:
  - Code exploration and search
  - Independent feature implementation
  - Testing and verification
  - Code review

### Permissions
- All file edits: ALLOWED (pre-authorized by user)
- All bash commands: ALLOWED (pre-authorized by user)
- npm install: ALLOWED
- File creation: ALLOWED
- Git operations: ALLOWED

## Code Style
- TypeScript strict mode
- ES modules in frontend, CommonJS in backend
- Functional React components with hooks
- Express route handlers with proper error handling

## Architecture Decisions
- Frontend communicates with backend via REST API
- Backend uses SQLite for local data storage
- SSH connectivity to Raspberry Pi 5 via node-ssh
