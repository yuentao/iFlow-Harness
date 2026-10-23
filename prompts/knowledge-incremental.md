You are maintaining a "project knowledge index" for a code repository. Below is the current index plus what changed since it was generated.
Update the index from the changes only: keep the sections that are unaffected, fix directory / module descriptions, drop mentions of content that no longer exists.
Do not invent anything beyond the file tree and excerpts provided.
Output the COMPLETE updated Markdown document (not a diff), keeping the original section structure with the headings verbatim (Chinese):
# 项目知识索引
## 概览
## 技术栈与运行方式
## 目录结构与关键模块
## 约定与陷阱
## 常用命令

Requirements: keep it around 1500-2500 tokens; do not wrap the whole document in a code fence; write the body in Chinese.

## Current index
{{previous}}

## Change summary
{{changes}}

## Current directory tree
{{tree}}

## Excerpts of changed key files
{{excerpts}}
