# AI Manager Bot - Feature Roadmap

## Project Overview

**AI Manager Bot (AUF 1.0)** is a Telegram-based ADHD task management assistant powered by Claude/GPT. The bot uses OpenAI function calling (tools) for command execution, supports voice transcription via Whisper, and manages routines/tasks with cron-based scheduling.

---

## Implementation Status

| Feature | Status | Notes |
|---------|--------|-------|
| System Tag Prefix | ✅ Completed | System tags now prefix user messages |
| Tags → Tools Migration | ✅ Completed | All commands now use OpenAI tools |
| Memory Tools | ✅ Completed | UpdateMemory, GetMemory, ListMemory, DeleteMemory |
| Location Recognition | ✅ Completed | Parses location + live location sharing |
| Web Search Tool | ✅ Completed | DuckDuckGo instant answers + web results |
| Reverse Location Search | ✅ Completed | Nominatim geocoding + POI search |
| Web UI | 🔄 Planned | Tailwind + PrimeVue admin interface |
| Google Calendar | 📋 Planned | OAuth integration, read-focused |
| ElevenLabs Voice (TTS) | 📋 Planned | Keep Whisper STT, add TTS output |

---

## Feature Roadmap

### 1. Location Recognition ✅ COMPLETED

**Status:** Implemented
**Files modified:** `mediaParser.ts`, `constants.ts`

#### What was implemented
- Added `'location'` to `MediaType` union type
- `detectMediaType()` checks for `msg.location`
- `parseLocation()` method handles both regular and live locations
- Location metadata includes coordinates, accuracy, live status
- `MEDIA_UNDERSTANDING_PROMPT` updated with location handling instructions

---

### 2. Reverse Location Search (What's Nearby) ✅ COMPLETED

**Status:** Implemented
**Files created:** `locationService.ts`, `tools.location.ts`

#### What was implemented
- **API:** OpenStreetMap Nominatim (free, no API key)
- **Rate limiting:** 1.1 second minimum between requests
- **Services:**
  - `reverseGeocode()` - coordinates to address
  - `searchNearby()` - find places in bounding box
  - `findAmenities()` - search for specific place types
  - `getLocationSummary()` - brief location description
- **Tools:**
  - `ReverseGeocode` - get full address from coordinates
  - `SearchNearbyPlaces` - find nearby POIs (cafe, pharmacy, etc.)
  - `GetLocationSummary` - simple location string
- **Features:**
  - Haversine distance calculation
  - Amenity type mapping (coffee→cafe, gas→fuel station, etc.)
  - Results sorted by distance

---

### 3. Move System Tag to Prefix (Not Appended) ✅ COMPLETED

**Status:** Implemented
**Files modified:** `aiService.ts`

#### What was implemented
- Changed message formatting from `userMessage + systemTag` to `systemTag + userMessage`
- Updated in two locations:
  - Line 130: New message formatting
  - Line 359: History message formatting
- System tags now always prefix user content for clearer AI context

---

### 4. Complete Migration from Tags to Tools ✅ COMPLETED

**Status:** Implemented
**Files modified:** `constants.ts`, `aiCommandService.ts`, `aiService.ts`, `tools.ts`
**Files created:** `tools.memory.ts`, `tools.user.ts`

#### What was implemented
- **New tools created:**
  - `tools.memory.ts`: UpdateMemory, GetMemory, ListMemory, DeleteMemory
  - `tools.user.ts`: SetGoal, GetGoal, ClearGoal
- **System prompts updated:**
  - Removed all XML tag examples from `constants.ts`
  - Added tool usage examples (AddTask, UpdateTask, etc.)
  - Updated `API_PROMPT` with full tool documentation
- **Tag parsing removed:**
  - `aiCommandService.ts` now only cleans stray tags and `<thinking>` blocks
  - All command execution flows through OpenAI tools
- **Tools enabled by default:**
  - `enableToolCalls` defaults to `true` in `aiService.ts`
  - Only disables after 5 recursion depth to prevent infinite loops

---

### 5. Memory Updates Migration to Tools ✅ COMPLETED

**Status:** Implemented (part of Feature #4)
**Files created:** `tools.memory.ts`
**Files modified:** `userStore.ts`, `tools.ts`

#### What was implemented
- **Memory tools:**
  - `UpdateMemory` - store/update user preferences
  - `GetMemory` - retrieve specific memory key
  - `ListMemory` - get all stored memories
  - `DeleteMemory` - remove a memory entry
- **UserStore helpers added:**
  - `getUserMemory(userId, key)`
  - `getAllUserMemory(userId)`
  - `deleteUserMemory(userId, key)`
- **All tools registered** in `tools.ts` and available to AI

---

### 6. Web Search Tool ✅ COMPLETED

**Status:** Implemented
**Files created:** `searchService.ts`, `tools.search.ts`

#### What was implemented
- **API:** DuckDuckGo (free, no API key)
- **Rate limiting:** 1 second minimum between requests
- **Services:**
  - `getInstantAnswer()` - DuckDuckGo Instant Answer API for facts/definitions
  - `searchWeb()` - HTML parsing of DuckDuckGo search results
  - `search()` - combined function returning both instant answers and web results
- **Tools:**
  - `WebSearch` - full search with instant answers + web results
  - `GetInstantAnswer` - quick factual lookups (faster, simpler)
- **Features:**
  - Returns structured results: title, URL, snippet
  - Related topics from instant answers
  - Configurable number of results (max 10)

---

### 7. ElevenLabs Voice Integration (TTS Only)

**Priority:** Medium
**Complexity:** High
**New files:** `voiceService.ts`, `tools.voice.ts`

**Decision: TTS only** - Keep Whisper for STT, use ElevenLabs for voice output

#### Current State
- **Speech-to-Text:** OpenAI Whisper (working, keep as-is)
- **Text-to-Speech:** Not implemented
- No ElevenLabs integration

#### Implementation Plan

**Step 1: Create voice service**
- New file: `voiceService.ts`
- Implement ElevenLabs TTS API integration
- Support multiple voices
- Handle audio format conversion

```typescript
interface VoiceService {
    textToSpeech(text: string, voiceId?: string): Promise<Buffer>;
    listVoices(): Promise<Voice[]>;
    getVoiceSettings(): VoiceSettings;
}
```

**Step 2: Integrate with Telegram**
- File: `index.ts`
- Add voice response capability
- Send audio messages via `bot.sendVoice()`

**Step 3: Create voice preference tools**
- New file: `tools.voice.ts`

```typescript
{
    name: 'SendVoiceMessage',
    description: 'Send a voice message to the user instead of text',
    parameters: {
        text: string,       // Text to convert to speech
        voice_id?: string   // Optional voice selection
    }
}

{
    name: 'SetVoicePreference',
    description: 'Set user preference for voice responses',
    parameters: {
        enabled: boolean,
        voice_id?: string
    }
}
```

**Step 4: Update AI behavior**
- Add context awareness for when to use voice
- Examples: User sent voice → respond with voice
- Add user preference storage for voice mode

**Step 5: Environment configuration**
```
ELEVENLABS_API_KEY=xxx
ELEVENLABS_VOICE_ID=xxx     # Default voice
ELEVENLABS_MODEL=eleven_monolingual_v1
```

**Step 6: Cost considerations**
- ElevenLabs charges per character
- Implement response length limits for voice
- Add user quotas if needed
- Consider caching common responses

---

### 8. Google Calendar Integration

**Priority:** Medium
**Complexity:** Medium-High
**New files:** `calendarService.ts`, `tools.calendar.ts`

**Decision: Google Calendar only** with OAuth link in chat

#### Current State
- No calendar integration exists
- Tasks/routines are managed internally only
- No sync with external calendars

#### Implementation Plan

**Step 1: Google Cloud Setup**
- Create project in Google Cloud Console
- Enable Google Calendar API
- Create OAuth 2.0 credentials (Web application type)
- Configure redirect URI for your bot's callback endpoint

**Step 2: Create calendar service**
- New file: `calendarService.ts`
- Implement OAuth2 flow for Google
- Store tokens per user in `userStore`

```typescript
interface CalendarService {
    // Auth
    getAuthUrl(userId: number): string;
    handleCallback(userId: number, code: string): Promise<void>;
    isAuthenticated(userId: number): boolean;

    // Calendar operations
    listCalendars(): Promise<Calendar[]>;
    listEvents(calendarId: string, timeMin: Date, timeMax: Date): Promise<Event[]>;
    createEvent(calendarId: string, event: EventInput): Promise<Event>;
    updateEvent(calendarId: string, eventId: string, event: EventInput): Promise<Event>;
    deleteEvent(calendarId: string, eventId: string): Promise<void>;
}
```

**Step 3: OAuth flow via Telegram**
- User requests calendar connection: `/connect-calendar`
- Bot sends OAuth URL as clickable link
- User authorizes in browser
- Callback endpoint receives code, exchanges for tokens
- Bot confirms connection in chat

```typescript
// OAuth callback handler (needs web server)
app.get('/oauth/google/callback', async (req, res) => {
    const { code, state } = req.query; // state contains userId
    await calendarService.handleCallback(userId, code);
    res.send('Calendar connected! Return to Telegram.');
});
```

**Step 4: Create calendar tools**
- New file: `tools.calendar.ts`

```typescript
{
    name: 'ConnectCalendar',
    description: 'Get OAuth link to connect Google Calendar',
    parameters: {}
}

{
    name: 'ListCalendarEvents',
    description: 'List upcoming events from user calendar',
    parameters: {
        days_ahead?: number,    // Default: 7
        calendar_id?: string    // Default: primary
    }
}

{
    name: 'CreateCalendarEvent',
    description: 'Create a new calendar event',
    parameters: {
        title: string,
        start_time: string,     // ISO datetime
        end_time?: string,      // ISO datetime (defaults to +1 hour)
        description?: string,
        calendar_id?: string
    }
}

{
    name: 'SyncTaskToCalendar',
    description: 'Create calendar event from existing task',
    parameters: {
        task_id: string,
        calendar_id?: string
    }
}
```

**Step 5: Token storage**
- Extend `userStore.ts` to store OAuth tokens
- Add token refresh logic (access tokens expire in 1 hour)
- Secure storage considerations

```typescript
// Add to user profile
interface UserProfile {
    // ... existing fields
    calendarTokens?: {
        google?: {
            access_token: string;
            refresh_token: string;
            expiry_date: number;
        }
    }
}
```

**Step 6: Web server for OAuth callback**
- Add Express.js or similar for callback endpoint
- Or use Telegram's WebApp feature for inline auth
- Consider ngrok/localtunnel for development

**Step 7: Environment configuration**
```env
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
GOOGLE_REDIRECT_URI=https://your-domain.com/oauth/google/callback
```

#### Architecture Considerations

**Option A: Separate Web Server**
- Add Express alongside Telegram bot
- Handle OAuth callbacks on `/oauth/*` routes
- More flexible, standard approach

**Option B: Telegram WebApp**
- Use Telegram's built-in WebApp feature
- Opens mini-app inside Telegram
- More integrated UX, but more complex

**Recommended: Option A** for simplicity

#### Task-Calendar Sync Options

1. **One-way sync (Task → Calendar)**
   - User creates task → Option to add to calendar
   - Simple, less conflict risk

2. **Two-way sync**
   - Calendar events create tasks
   - Task completion updates calendar
   - More complex, requires webhooks

**Recommended: Start with one-way sync**

---

### 9. Web UI (Admin Interface)

**Priority:** Medium
**Complexity:** Medium
**New files:** `server.ts`, `web/` directory
**Dependencies:** None (can use existing Express from Calendar OAuth)

**Stack:** Vue 3 + PrimeVue + Tailwind CSS

#### Goals
- Simple admin interface to view and edit user data
- Direct database access for debugging and management
- No complex authentication (internal tool initially)

#### Implementation Plan

**Step 1: Express.js Server Setup**
- File: `server.ts`
- Shared with Google Calendar OAuth callback
- Serve static Vue app + API endpoints

```typescript
// server.ts
import express from 'express';
import path from 'path';

const app = express();

// API routes
app.use('/api', apiRouter);

// Serve Vue app
app.use(express.static(path.join(__dirname, 'web/dist')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'web/dist/index.html'));
});

export { app };
```

**Step 2: API Endpoints**

```typescript
// routes/api.ts
const router = express.Router();

// Users
router.get('/users', listUsers);
router.get('/users/:id', getUser);

// History (messages)
router.get('/users/:id/history', getUserHistory);
router.delete('/users/:id/history/:messageId', deleteMessage);

// Memory
router.get('/users/:id/memory', getUserMemory);
router.put('/users/:id/memory/:key', updateMemory);
router.delete('/users/:id/memory/:key', deleteMemory);

// Routines
router.get('/users/:id/routines', getUserRoutines);
router.put('/users/:id/routines/:routineId', updateRoutine);
router.delete('/users/:id/routines/:routineId', deleteRoutine);

// Tasks
router.get('/users/:id/tasks', getUserTasks);
router.put('/users/:id/tasks/:taskId', updateTask);
router.delete('/users/:id/tasks/:taskId', deleteTask);
```

**Step 3: Vue 3 Frontend Setup**

```bash
# Initialize Vue project
cd web
npm create vite@latest . -- --template vue-ts
npm install primevue @primevue/themes tailwindcss postcss autoprefixer
npm install @primevue/icons primeicons
```

**Step 4: UI Components**

```
web/
├── src/
│   ├── App.vue
│   ├── main.ts
│   ├── views/
│   │   ├── Dashboard.vue       # Overview of all users
│   │   ├── UserDetail.vue      # Single user view
│   │   ├── History.vue         # Message history
│   │   ├── Memory.vue          # Memory editor
│   │   ├── Routines.vue        # Routine manager
│   │   └── Tasks.vue           # Task manager
│   ├── components/
│   │   ├── UserList.vue
│   │   ├── MessageCard.vue
│   │   ├── MemoryTable.vue
│   │   ├── RoutineCard.vue
│   │   └── TaskCard.vue
│   └── api/
│       └── client.ts           # API client
```

**Step 5: Key Views**

**Dashboard (User List)**
- Table of all users (PrimeVue DataTable)
- Columns: ID, Name, Goal, Last Active, Task Count
- Click to view user detail

**User Detail**
- Tabs: History | Memory | Routines | Tasks
- Quick stats at top

**History View**
- Scrollable message list
- Filter by date range
- Delete individual messages
- Search within history

**Memory View**
- Editable key-value table (PrimeVue DataTable with inline editing)
- Add new memory entries
- Delete entries

**Routines View**
- Cards for each routine
- Edit cron schedule inline
- Toggle active/inactive
- Delete routine

**Tasks View**
- Filterable table (pending/completed/failed)
- Edit task details
- Mark complete/failed
- Delete task

**Step 6: PrimeVue + Tailwind Integration**

```typescript
// main.ts
import { createApp } from 'vue';
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';
import App from './App.vue';
import router from './router';

import 'primeicons/primeicons.css';
import './style.css'; // Tailwind

const app = createApp(App);
app.use(PrimeVue, {
    theme: {
        preset: Aura,
        options: { darkModeSelector: '.dark' }
    }
});
app.use(router);
app.mount('#app');
```

```css
/* style.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**Step 7: Environment & Build**

```env
# .env
WEB_UI_PORT=3000
WEB_UI_ENABLED=true
```

```json
// package.json scripts
{
    "scripts": {
        "dev:bot": "tsx watch index.ts",
        "dev:web": "cd web && npm run dev",
        "build:web": "cd web && npm run build",
        "start": "tsx index.ts"
    }
}
```

#### Minimal MVP Features

1. **View user list** with basic info
2. **View message history** (read-only initially)
3. **View/edit memory** entries
4. **View routines** and tasks
5. **Delete** individual items

#### Future Enhancements

- Authentication (basic auth or API key)
- Real-time updates via WebSocket
- Bulk operations
- Export data to JSON/CSV
- Dark mode toggle
- Mobile-responsive layout

---

## Implementation Priority Matrix

| Feature | Status | Priority | Complexity | API Cost |
|---------|--------|----------|------------|----------|
| 3. System Tag Prefix | ✅ Done | High | Low | Free |
| 4. Tags → Tools Migration | ✅ Done | High | High | Free |
| 5. Memory Tools | ✅ Done | High | Medium | Free |
| 1. Location Recognition | ✅ Done | High | Medium | Free |
| 6. Web Search Tool | ✅ Done | Medium | Medium | Free (DuckDuckGo) |
| 2. Reverse Location Search | ✅ Done | Medium | Medium | Free (Nominatim) |
| 9. Web UI | 🔄 Next | Medium | Medium | Free |
| 8. Google Calendar | 📋 Planned | Medium | Medium-High | Free |
| 7. ElevenLabs Voice (TTS) | 📋 Planned | Low | High | Paid |

---

## Recommended Implementation Order

1. ~~**System Tag Prefix**~~ ✅ Completed
2. ~~**Tags → Tools Migration**~~ ✅ Completed
3. ~~**Memory Tools**~~ ✅ Completed
4. ~~**Location Recognition**~~ ✅ Completed
5. ~~**Web Search Tool**~~ ✅ Completed
6. ~~**Reverse Location Search**~~ ✅ Completed
7. **Web UI** - Admin interface for data management (Tailwind + PrimeVue)
8. **Google Calendar** - External calendar sync (shares Express server with Web UI)
9. **ElevenLabs Voice** - Adds audio output (paid API, lowest priority)

---

## Technical Debt to Address

1. ~~**Dual command system**~~ ✅ Fixed - Tags removed, all commands use tools
2. ~~**No API rate limiting**~~ ✅ Fixed - Added for DuckDuckGo and Nominatim
3. **No caching** - Add caching layer for API responses
4. **Single JSON database** - Consider migration to SQLite or PostgreSQL for scale
5. **No error recovery** - Add retry logic for transient API failures

---

## Environment Variables Summary (New)

```env
# Location Services (Nominatim - no key required)
# Just respect rate limits: 1 request/second

# Web Search (DuckDuckGo - no key required)
# Just respect rate limits

# Google Calendar
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxx
GOOGLE_REDIRECT_URI=https://your-domain.com/oauth/google/callback

# Voice (ElevenLabs) - Optional, paid
ELEVENLABS_API_KEY=xxx
ELEVENLABS_VOICE_ID=xxx
ELEVENLABS_MODEL=eleven_monolingual_v1
```

---

## File Structure (Current + Planned)

```
/
├── index.ts                  # Main Telegram bot
├── aiService.ts              # AI service (tools only)
├── aiCommandService.ts       # Tag cleanup only (legacy parsing removed)
├── userStore.ts              # LowDB database
├── mediaParser.ts            # Media handling (+ location) ✅
├── constants.ts              # Prompts (tools-based) ✅
├── dateUtils.ts              # Date utilities
│
├── locationService.ts        # ✅ Nominatim geocoding & POI
├── searchService.ts          # ✅ DuckDuckGo search
│
├── tools.ts                  # ✅ Tool registry (27 tools)
├── tool.types.ts             # Type definitions
├── tools.tasks.ts            # Task tools
├── tools.routines.ts         # Routine tools
├── tools.meta.ts             # Meta tools
├── tools.memory.ts           # ✅ Memory tools
├── tools.user.ts             # ✅ Goal tools
├── tools.location.ts         # ✅ Location tools
├── tools.search.ts           # ✅ Search tools
│
├── server.ts                 # 📋 PLANNED: Express server (Web UI + OAuth)
├── calendarService.ts        # 📋 PLANNED: Google Calendar OAuth + API
├── voiceService.ts           # 📋 PLANNED: ElevenLabs TTS
├── tools.calendar.ts         # 📋 PLANNED: Calendar tools
├── tools.voice.ts            # 📋 PLANNED: Voice tools
│
└── web/                      # 📋 PLANNED: Vue 3 + PrimeVue + Tailwind
    ├── src/
    │   ├── App.vue
    │   ├── main.ts
    │   ├── views/
    │   │   ├── Dashboard.vue
    │   │   ├── UserDetail.vue
    │   │   ├── History.vue
    │   │   ├── Memory.vue
    │   │   ├── Routines.vue
    │   │   └── Tasks.vue
    │   └── components/
    │       └── ...
    └── package.json
```
