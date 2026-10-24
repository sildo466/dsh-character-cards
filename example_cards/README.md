# Example cards

Ready-to-import `.dshcd` files. Open Settings -> 角色卡 -> 导入 and pick a file. To keep a modified version, copy it first and edit the copy.

| File | Character | Notes |
|---|---|---|
| `patient-teacher.dshcd` | 耐心的教学者 | Explains every step; good for learning. |
| `terse-reviewer.dshcd` | 简短审阅者 | Direct, no filler; good for code review. |
| `grumpy-veteran.dshcd` | 暴躁老哥 | Deliberately extreme diagnostic card; useful for checking that a prompt reaches the model. |
| `fsar.dshcd` | FSAR · 个人 AI 伴侣 | Ported from FSAR's built-in default card. |
| `coding-coach.dshcd` | 代码教练 | Ported from FSAR; review, debug, explain. |
| `research-analyst.dshcd` | 研究分析师 | Ported from FSAR; formal, structured, evidence-first. |

The three FSAR cards keep their original `example_dialogues` and `tags` fields. This build does not render those fields, but it preserves them on save and export.

These are starting points, not fixed presets: duplicate one, change the identity and voice, and save it as your own.
