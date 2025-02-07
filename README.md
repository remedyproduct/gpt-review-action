# AI Code Review Action

This GitHub Action performs an AI-based review of a Pull Request. It then posts a comment in the PR summarizing any potential **logic** issues or concerns, ordered by severity.

## Overview

The AI Code Review Action is designed to:
1. Check out your repository.
2. Compare the current branch to the `main` branch and generate a diff with extended context.
3. Send that diff to a GPT model using OpenAI's API.
4. Post the AI-generated feedback directly into the PR.

## Usage

### Create a Workflow File (`code-review.yaml`)

Below is the sample workflow file you can place in `.github/workflows/code-review.yaml`. It will allow you to manually trigger the review process and select which GPT model to use.

```yaml
name: AI Code Review

on:
  # Manually trigger the workflow from GitHub's UI
  workflow_dispatch:
    inputs:
      model:
        type: choice
        description: "GPT Model"
        default: gpt-4o-mini
        options:
          - gpt-4o-mini
          - gpt-4o
          - o1-mini
          - o1-preview
        required: true
      extra_prompt:
        type: string
        description: "Extra Prompt"
        required: false
        default: ""

permissions:
  contents: read
  issues: write
  pull-requests: write

jobs:
  review_job:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4
        with:
          fetch-depth: "0"

      - name: Run PR Reviewer Action
        uses: remedyproduct/gpt-review-action@1bb26f2a6e09665181bb3d2a88b7cd3c58d03cb5
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          openai_token: ${{ secrets.OPENAI_TOKEN }}
          openai_model: ${{ github.event.inputs.model }}
          extra_prompt: ${{ github.event.inputs.extra_prompt }}