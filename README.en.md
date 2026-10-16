# Sense Murmur

**Create characters and casts, build shared history, and explore stories, companionship, learning, and creative work.**

Sense Murmur is an AI interaction and creation app built around persistent character lives. Start with a character concept, a story, or an entire cast. Build personalities, relationships, and visual identities, then spend time with those characters in group conversations, private chats, stories, discussions, and learning rooms.

Shared experiences enter layered memory and influence relationships, emotion, and later expression. Diaries, letters, moments, and calendar activities preserve more of that history. Natural-language app actions, web research, file tools, and versioned Agent artifacts let you turn conversation into creative work within the same app.

[Try It Online](https://sense.lyixi.com) · QQ community: 571886312 · [简体中文](./README.md)

## At a Glance

| Capability | What you can experience |
|---|---|
| Character and cast creation | Extract people from a story or script, generate profiles in batches, inspect relationship circles, and complete visuals and voices |
| Multi-character rooms | Characters respond to one another, argue, hold back, or form rapport; you can direct a speaker or introduce an event |
| Persistent characters | Identity, memory, relationships, emotion, and the current room influence each response |
| Layered memory | Personal history, impressions of others, shared room history, and significant events are stored and recalled in context |
| Relationships and companionship | Closeness, trust, caution, and short-lived emotion affect tone, stance, addressing, and care |
| Life records | Birth letters, diaries, farewell letters, social moments, and calendar activities |
| Multimedia | Image input and generation, character visuals, voice input and playback, rich messages, files, and reference images |
| Assistant and Agent | Create and revise documents, code, diagrams, tables, images, and interactive pages |
| Natural-language operations | Create characters and rooms, find old conversations, compare people, and manage existing content |
| Files and workspaces | Upload attachments, read web pages, save network resources, and organize files in authorized directories |
| Template market | Browse and import characters, chat templates, and bundles; submit your own work for review |
| Different rooms | Group chat, story, deliberation, learning, one-to-one chat, and private character threads |
| Personal control | Choose models and preferences, keep local data first, and enable account sync when needed |

## Build a Cast From an Idea

Edit characters individually or use AI generation and batch completion. Supply a short description, story, script, or conversation to extract a cast and relationship clues, choose the people you want, and generate their full profiles.

- **Character foundations:** Background, expertise, desires, fears, values, self-image, attachment, and conflict style.
- **Distinct expression:** Personality and behavior parameters, habitual phrases, sentence length, sarcasm, speaking habits, and expressions to avoid.
- **Relationships:** Directional ties, relationship graphs and circles, and suggested links between new and existing characters.
- **Appearance and voice:** Visual descriptions, reference images, avatars, generated artwork, and configured or automatically matched voices.
- **Library management:** Groups, filters, import/export, batch completion, and separate model choices for text, images, and speech.

A family, club, rival factions, or the cast of a story can enter a room with their internal relationships already established. Join the conversation, observe the characters, or guide the situation as a director.

## What “Digital Life” Means Here

A digital life in Sense Murmur is **your persistent character instance**. The term makes no claim that AI is conscious. You define a character's identity, personality, appearance, habits, and boundaries; your shared experiences then become part of that character's history.

Two people can begin with the same character concept and arrive at different relationships. A promise, an argument, or a moment of support can affect what the character remembers and how they respond. When the character moves to another room, their longer-term history remains relevant, while the new room supplies its own roles and circumstances.

Before a response, the runtime assembles the character's current situation:

```text
Identity and growth
  + layered memories and shared experiences
  + relationship with the current person
  + recent emotion and unfinished concerns
  + room topic, rules, and group dynamics
  -> current perspective and expression context
  -> a reply, an action, or a choice to stay silent
  -> new messages, events, and validated state changes
```

This involves character records, memory retrieval, relationship updates, speaker scheduling, generation protocols, and state commits. The visible result is a character who may remember an earlier conversation or react differently after a disagreement; the engineering work keeps those changes grounded and available later.

You can see those systems connect in ordinary use:

- A disagreement in a group leaves an interaction event and may affect how characters see each other. A later diary can reflect on it from one character's perspective, and a private chat can carry the aftereffect forward.
- Upload a reference image and a vision-capable model can summarize what it sees. Later, a request to use “this image's style” can resolve the relevant image and send the selected reference to the image service.
- Completing an exercise in a learning room leaves answer and assessment evidence. The room can use its topic state, review needs, and saved materials when you return.

### Character Through Behavior

A character profile includes values, motivations, fears, habits, and speaking style. The current relationship and emotion shape whether they approach, defend, question, avoid, or let somebody else speak. Emotion can change quickly after an interaction, while lasting relationship changes need stronger evidence.

A group room also considers the topic, who has spoken recently, outstanding replies, relationships between members, and the room's social atmosphere. Direct requests and open conversation follow different paths. A character can answer, offer a short reaction, or remain silent.

The runtime supports restraint, bias, care, hesitation, and disagreement while retaining the character's identity. Results still depend on the model; repeated patterns and incorrect references remain areas of active evaluation.

## Memory, Relationships, and Emotion

### From Working Memory to Lasting Knowledge

Memory has three layers, with separate ownership for the character, particular relationships, rooms, and private threads:

| Layer | Purpose |
|---|---|
| Working | Recent interactions, the current topic, and outstanding matters |
| Episodic | Specific conflicts, choices, promises, and shared experiences |
| Long-term | Stable understanding, relationship judgments, and significant personal context |

Experiences become candidates for creation, reinforcement, revision, merging, or archiving. Repeated evidence can be consolidated and distilled into more stable knowledge. Retrieval considers the current topic, relationships, importance, and recency. Archived material is managed separately from active memory to keep each turn focused.

“You dislike overly sweet drinks” is a preference. “You ordered a sweet drink, left half of it unfinished, and made it a shared joke” is an experience. The character can use that history naturally when recommending a drink later. You can inspect and organize memories in the character view.

Long-term facts such as relationships, promises, and calendar plans need structured results, explicit actions, or traceable events. A stray word in a message should not manufacture shared history.

### Relationships With Different People

Characters have relationships with you and with one another. The system tracks dimensions such as warmth, respect for competence, trust, and perceived threat, alongside the events and impressions behind them. Someone can respect another character's ability while doubting their judgment. A temporary alliance in one room need not erase a long-term bond.

Attachment and willingness to yield add further nuance: a character can care deeply while disagreeing, or acknowledge someone's competence while remaining guarded. Relationships contribute to who speaks and how: who helps, challenges, yields, or becomes guarded. Context from a private conversation can inform the same character in a group, story, or discussion while respecting visibility rules.

### Emotion and Companionship

Immediate emotion affects attention and expression in the current turn and can leave a short-lived aftereffect. Over time, shared names, habits, promises, and ways of caring become part of a relationship's rhythm.

Private chats can use more detailed personal context. Proactive care and diary generation are controlled by settings, timing, and context. Public rooms receive only what can be shared safely.

Companionship includes shared forms of address, inside jokes, promises, relationship rituals, and attempts to repair conflict. Configure proactive care, ritual types, intensity, cooldowns, quiet hours, and how explicitly memories appear in replies.

Characters also have online, away, and activity states that affect availability. Give direct feedback when a reply is out of character, too long, too formal, or too assistant-like, or mark an expression that fits. That feedback can inform later expression context.

## A Life Beyond the Chat Window

**Diaries and letters.** Characters can write birth letters, diaries, and farewell letters. Diaries draw on recent experiences, relationships, emotions, and unfinished thoughts. Read them in the Letters and Diary view, filter by character, and manage deleted entries. Automatic diary generation can be switched on or off.

**Moments and calendar.** Moments show everyday character activity and interaction. The calendar tracks plans and activities. These views give room events a place to echo beyond chat; automatic updates depend on settings, model access, and runtime conditions.

**Care, gifts, and invitations.** The social runtime can propose greetings, reactions to moments, gifts, and shared activities, then continue them in public or private conversation. Pending intentions and completed events have separate states. Confirmed activities and outcomes can feed relationship and memory updates. Add calendar events manually or filter activities by character and conversation.

**Visual identity.** Characters can have avatars and visual references, with image generation for new material. Group chats can also have their own avatar and background. Character visuals and message images have separate ownership and storage rules.

Diaries, social events, and new experiences can contribute to later companionship context. A promise may return in a future conversation; a disagreement may leave something to repair. These continuations depend on the active runtime, generation settings, and recorded events. Continuous autonomous operation after closing the app remains future work.

## Rooms and Ways to Participate

- **Group chat:** Bring a cast into one conversation. They can follow the topic, respond to one another, or hold back. Pause, direct a reply, speak as a character, or introduce an event.
- **One-to-one and character threads:** Talk privately with a character; characters can also have separate private threads. Each channel has its own visibility rules.
- **Story rooms:** Set the opening, follow narration and dialogue, and make branching choices with characters who already have history together.
- **Deliberation:** Let different viewpoints examine, challenge, and summarize a question.
- **Learning:** Set a goal and teaching style. Topics, exercises, answers, evidence, and review records accumulate over time.

These four group-room families and their presets are available from the standard creation flow. Other training scenarios, deduction games, and world simulation are being validated in developer mode.

### Keep the Paths You Explore

Edit messages, regenerate answers, and switch between revision branches to explore another phrasing or direction while retaining alternatives. Story rooms support branching choices, custom directions, chapter navigation, and reading-position recovery. Search conversation records to locate earlier material and continue browsing long histories.

Learning rooms retain goals, topics, exercises, and answer evidence in scenario state. Choose teaching and assessment styles, generate materials or interactive exercises, and return submissions to the teaching workflow. Deliberation presets organize different perspectives, questioning, and summaries.

## Images, Voice, and Rich Messages

Conversations can contain Markdown, code, images, files, and voice. Upload an image or file and discuss it with a model that supports the appropriate input. Characters and the assistant can generate images on request; images can become references for further variants.

With suitable services configured, use voice input, hear spoken replies, and assign voices to characters. Text, images, and speech can appear in the same interaction. Media tasks show progress and failure states. Availability depends on your selected models and providers.

The Files page brings together conversation images, audio, avatars, character visuals, and backgrounds. Filter, preview, download, or clean up multiple items, and check storage usage and sync status. Creative artifacts have a separate panel for content, files, and versions.

## Assistant and Agent: Work You Can Keep

The general assistant handles questions, explanations, and writing. Optional Agent capabilities turn a conversation into managed work:

| Artifact | What it supports |
|---|---|
| Documents and code | Reports, plans, tutorials, snippets, and multi-file text projects |
| Diagrams and data | Diagram source, tables, JSON, and CSV that can be queried or revised |
| Interactive pages | Small tools, forms, exercises, and previewable HTML pages |
| Images | Generation from descriptions or references, with subsequent variants and versions |

### Revise Work With a Version History

The Agent identifies the task and target, prepares changes, validates them, and commits new versions. One task can update several artifacts, and one artifact can contain multiple text files. Revisit, preview, copy, download, and continue editing earlier versions; ambiguous requests ask for clarification.

Tables and JSON support queries, filters, sorting, pagination, and record changes. HTML artifacts can contain forms, exercises, and interactive tools. Submissions return to the model for assessment, explanation, or another revision. Page runtime errors can also be sent to the assistant for repair.

### Research and File Tools

- **Web research:** Search through configured providers, read a URL as readable content or source, and save resources to the conversation or export them to your device.
- **Attachments and transfers:** Upload text and other files within the available parsing capabilities. Network tools support HTTP(S), anonymous FTP/FTPS, bounded directory transfers, ZIP extraction, and archive export.
- **Authorized workspaces:** In supported browsers, authorize folders, list and select text files, and let the Agent read or organize them. Write, copy, move, delete, and transfer files between conversation storage and workspaces. Operations such as bulk overwrites, deletion, and cross-directory moves require confirmation.
- **Desktop tools:** Electron exposes controlled command execution, system open/reveal actions, and Office inspection and conversion interfaces through `officecli`. These require the relevant environment, settings, and authorization. Web and mobile expose the tools their platforms support.

Without an authorized directory, the Agent works with conversation artifacts and explicitly uploaded attachments. Keep generated work in the conversation, then choose whether to download it or save it to a workspace.

Agent tools are configured per conversation. Learning rooms can reuse artifact tools for materials and exercises. Availability depends on models, account permissions, conversation settings, and device capabilities.

## Operate the App in Natural Language

Use the home command entry or ask the assistant to perform app actions: create a cast and a room from a story, find an earlier travel discussion, or compare several characters. Continue from the returned candidates or results.

Connected actions include individual and batch character creation, profile reading and comparison, permitted profile changes, private chats, room creation, conversation search, renaming, topic and membership changes, and deleting or restoring characters and conversations. You can also check AI credits, switch light/dark mode, select a default text model, or set a provider Key. Ambiguous or sensitive operations show choices or confirmation; complex creative tasks continue in an assistant conversation.

## Share a Starting Point Others Can Develop

The template market supports characters, chat templates, and bundles. Inspect the people and configuration before importing your own copy. Creators can submit from character and chat editors for review and publication.

Character templates preserve identity and presentation resources. Chat templates preserve scenario, gameplay, and director configuration. Bundles can also include internal relationships, memories, companionship starting points, and runtime seeds. Import creates new local instances whose later experiences belong to the user. Submission removes full chat history, private user information, credentials, and relationships outside the bundle.

## Data, Models, and Access

Characters, rooms, and conversations load from local data first. Configure your own models in local mode or sign in to use available platform models. Current models, pricing, and permissions are shown in the app. An AI gateway and Key management are also available for compatible external tools.

Account sync is optional. Importing guest data into an account requires confirmation, and account data remains separate. Artifact content is local by default; eligible text artifacts can sync when the account has permission and you enable it. Cached content remains viewable offline, while AI generation needs network access.

Use Sense Murmur in a browser or install the PWA. The project also includes desktop and Android packaging.

- **Manage your data:** Select categories for backup and restore, import/export character profiles, manage deleted characters and conversations in the recycle bin, and inspect sync status and errors.
- **Combine models:** Configure text, images, speech recognition, and speech synthesis separately, with character-level overrides. Platform models include usage and cost views; the AI gateway and Key management support compatible external tools.
- **Personalize the interface:** Chinese and English, light/dark/system modes, color presets, character bubbles, and letter-paper styles. Wide screens use list/detail panes, with corresponding page access on mobile.

## Get Started

1. Open [sense.lyixi.com](https://sense.lyixi.com) and choose local mode or sign in.
2. Configure a model or select one available to your account.
3. Choose a preset character or create your own.
4. Start a private chat or create a group, story, deliberation, or learning room.

Begin with a character and a topic, then explore the memories, relationships, diary entries, and artifacts that follow.

## Project Status and Community

Sense Murmur is under active development. Cast creation, relationship graphs, different room scenarios, layered memory, life records, multimedia, Agent work, natural-language operations, the template market, and data management have their own interfaces and execution paths, with connections across these workflows.

Ongoing work focuses on how these mechanisms hold up over time: consistent characters who can change, timely recall, natural group conversation, accurate follow-through on promises, and smooth artifact revision. Models can still repeat themselves, miss a memory, or misunderstand context. The app shows the current availability and requirements of each capability.

Share feedback and reproducible scenarios in QQ group 571886312. Remove private conversations and credentials before posting.

Developers can read the [full project's technical README](https://github.com/lyixi/Pneumata#readme). The frontend uses React, TypeScript, MUI, and Vite. Run this directory with `npm install` and `npm run dev`; local mode needs a configured model.
