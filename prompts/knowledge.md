You are generating a "project knowledge index" for a code repository, so a coding assistant can understand the project quickly in later sessions.
Use only the file tree and excerpts provided — do not invent modules, commands or dependencies that are not in them.
Output Markdown with this fixed structure, keeping the headings verbatim (Chinese):
# 项目知识索引
## 概览
## 技术栈与运行方式
## 目录结构与关键模块
## 约定与陷阱
## 常用命令

Requirements:
- Keep it around 1500-2500 tokens; information density first.
- Do not wrap the whole document in a code fence.
- Write the document body in Chinese. Mark anything you cannot confirm from the files as "未从文件中确认" instead of guessing.

Repository information:
{{digest}}
