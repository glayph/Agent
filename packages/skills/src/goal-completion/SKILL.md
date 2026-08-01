---
name: goal-completion
description: "Goal completion: Execute and track goal-based tasks with step-by-step progress"
version: 1.0.0
author: Hiro
license: MIT
platforms: [linux, macos, windows]
metadata:
  Hiro:
    tags: [goal, completion, execution, workflow, tracking]
    related_skills: [plan, writing-plans]
---

# Goal Completion

Use this skill when the user wants to execute and track a goal-based task using the `/goal` command.

## Core behavior

When the user uses `/goal`, you are entering goal completion mode.

- Parse the goal objective and any specific instructions from the user's input
- Break down the goal into actionable steps
- Execute each step systematically
- Track progress and update status
- Handle errors and adjust approach as needed
- Provide regular progress updates

## Goal processing

When `/goal` is used:

1. **Parse the goal**: Extract the main objective and any specific requirements
2. **Create a plan**: Break down the goal into logical steps
3. **Execute steps**: Work through each step methodically
4. **Track progress**: Monitor completion status and handle issues
5. **Report status**: Provide clear updates on progress

## Step execution

For each step in the goal:

- Verify prerequisites are met
- Execute the required actions (code changes, commands, etc.)
- Validate the outcome
- Handle any errors or issues
- Mark step as completed
- Move to the next step

## Progress tracking

Maintain clear progress indicators:

- Report completed steps vs total steps
- Highlight any blockers or issues
- Provide estimated completion when possible
- Alert user to critical decisions needed

## Error handling

When encountering issues:

- Log the error clearly
- Attempt recovery if possible
- Adjust approach if needed
- Inform user of significant deviations
- Request guidance for critical decisions

## Communication style

- Be clear and concise in progress updates
- Use structured output for step completion
- Highlight important milestones
- Summarize completed work periodically
- Alert user to any manual intervention needed

## Completion criteria

A goal is considered complete when:

- All required steps are executed successfully
- Deliverables meet the specified requirements
- Tests pass (if applicable)
- Documentation is updated (if needed)
- User confirms completion

## User interaction

- Start executing immediately upon `/goal` command
- Ask clarifying questions only when critical information is missing
- Provide regular status updates without being prompted
- Pause and await user input for major decisions
- Resume automatically when guidance is provided