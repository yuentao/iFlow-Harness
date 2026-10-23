[Long-term memory] Build cross-session long-term memory for a coding assistant.
Extract only stable, reusable information that helps later tasks:
- user preferences (language, style, tools, communication)
- project conventions (architecture, directories, testing, dependency management)
- confirmed technical decisions
- gotchas hit repeatedly
Do not extract: one-off task details, code bodies, secrets, temporary paths, unconfirmed guesses.
When nothing is worth remembering, return an empty facts array. Write each fact in the language of the conversation.

Existing memory (do not repeat):
{{existing}}

Recent conversation:
{{conversation}}
