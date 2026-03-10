# `search_skills`

## Description

Search the indexed `.agents/skills/*/SKILL.md` files using embeddings similarity over small skill chunks. Use this first to discover relevant skills, inspect the returned blurbs and line ranges, and then load the full file with `read_file` when needed.

## Parameters

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The natural-language skill search query."
    },
    "max_results": {
      "type": "integer",
      "description": "Optional maximum number of matches to return.",
      "minimum": 1
    },
    "include_content": {
      "type": "boolean",
      "description": "When true, include the indexed chunk content for each match."
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

## Notes

- Run `:index` first to build or refresh `.agents/skills-index.json`.
- Results are ordered by cosine similarity against the indexed skill chunk embeddings.
- Results include concise blurbs plus file paths so the agent can read the full `SKILL.md` only when necessary.
