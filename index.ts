import * as core from '@actions/core';
import * as github from '@actions/github';
import {exec} from 'child_process';
import OpenAI from 'openai';
import {promisify} from 'util';

const execAsync = promisify(exec);

/**
 * Fetch the latest code from main branch.
 */
async function fetchMainBranch(): Promise<void> {
  core.info('Fetching latest code from main...');
  await execAsync('git fetch origin main');
}

/**
 * Generate a diff between the main branch and the current HEAD.
 * Includes extended context to help with AI-based review.
 *
 * @returns The diff content (string).
 */
async function generateDiff(): Promise<string> {
  core.info('Generating diff...');
  const { stdout, stderr } = await execAsync('git diff --inter-hunk-context=1000 origin/main...HEAD');
  if (stderr) {
    core.warning(`Standard error while generating diff: ${stderr}`);
  }
  return stdout;
}

/**
 * Create and return an OpenAI client instance (v4 syntax).
 *
 * @param openaiToken - The OpenAI API token.
 * @returns An instance of the new OpenAI client.
 */
function createOpenAIClient(openaiToken: string): OpenAI {
  // apiKey can be omitted if the env var is already set, but included here for clarity
  return new OpenAI({ apiKey: openaiToken });
}

/**
 * Generate feedback using OpenAI, given a diff and a model name.
 *
 * @param openai - The OpenAI client (v4).
 * @param model - The OpenAI model (e.g., 'gpt-3.5-turbo').
 * @param diff - The diff content to analyze.
 * @returns AI-generated feedback (string).
 */
async function generateFeedback(openai: OpenAI, model: string, diff: string): Promise<string> {
  core.info('Generating feedback from OpenAI...');

  // The prompt is passed via messages in a chat-style request
  const userPrompt = `Check this PR code, find logic issues not easily found by static analysis tools, order them by severity.\n\nPlease review the following diff:\n${diff}\n`;

  // New usage: openai.chat.completions.create(...)
  const chatCompletion = await openai.chat.completions.create({
    model,
    messages: [{ role: 'user', content: userPrompt }],
  });

  // Extract the message text from the first choice
  return chatCompletion.choices[0].message?.content?.trim() || '';
}

/**
 * Find an open PR corresponding to a given branch.
 *
 * @param octokit - The authenticated GitHub client.
 * @param branch - The branch name to find a PR for.
 * @returns The PR number if found, otherwise null.
 */
async function findOpenPullRequest(
  octokit: ReturnType<typeof github.getOctokit>,
  branch: string
): Promise<number | null> {
  core.info(`Searching for open PR for branch '${branch}'...`);

  const { data: pullRequests } = await octokit.rest.pulls.list({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    head: `${github.context.repo.owner}:${branch}`,
    state: 'open',
  });

  if (pullRequests.length === 0) {
    core.warning(`No open PR found for branch '${branch}'.`);
    return null;
  }

  const prNumber = pullRequests[0].number;
  core.info(`Found PR #${prNumber}.`);
  return prNumber;
}

/**
 * Minimal interface for a GitHub comment retrieved via octokit.
 */
interface GitHubComment {
  id: number;
  body?: string | undefined;
}
/**
 * Find an existing bot comment marked with `<!-- GPT-BOT-COMMENT -->` in a given PR.
 *
 * @param octokit - The authenticated GitHub client.
 * @param prNumber - The pull request number.
 * @returns The existing comment object if found, otherwise null.
 */
async function findExistingBotComment(
  octokit: ReturnType<typeof github.getOctokit>,
  prNumber: number
): Promise<GitHubComment | null> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: prNumber,
  });

  // Use optional chaining to avoid errors if user/body are undefined
  const botComment = comments.find((comment) =>
    comment.user?.type === 'Bot' && comment.body?.includes('<!-- GPT-BOT-COMMENT -->')
  );

  return botComment || null;
}
/**
 * Update or create a comment in a PR with the AI-generated feedback.
 *
 * @param octokit - The authenticated GitHub client.
 * @param prNumber - The pull request number.
 * @param botComment - The existing bot comment object if found.
 * @param feedback - The AI-generated feedback content.
 */
async function updateOrCreateBotComment(
  octokit: ReturnType<typeof github.getOctokit>,
  prNumber: number,
  botComment: GitHubComment | null,
  feedback: string
): Promise<void> {
  const commentBody = `<!-- GPT-BOT-COMMENT -->\n${feedback}`;

  if (botComment) {
    core.info('Updating existing bot comment...');
    await octokit.rest.issues.updateComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      comment_id: botComment.id,
      body: commentBody,
    });
  } else {
    core.info('Creating new bot comment...');
    await octokit.rest.issues.createComment({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
      body: commentBody,
    });
  }
}

/**
 * Main function to orchestrate the entire process, with updated OpenAI v4 usage.
 */
async function main(): Promise<void> {
  try {
    // Retrieve inputs
    const githubToken = core.getInput('github_token', { required: true });
    const openaiToken = core.getInput('openai_token', { required: true });
    const openaiModel = core.getInput('openai_model') || 'gpt-3.5-turbo';

    // Set up GitHub and OpenAI clients
    const octokit = github.getOctokit(githubToken);
    const openai = createOpenAIClient(openaiToken);

    // Determine the current branch
    const ref = github.context.ref; // e.g., "refs/heads/feature-branch"
    if (!ref || !ref.startsWith('refs/heads/')) {
      throw new Error(`GITHUB_REF is not a valid branch reference: ${ref}`);
    }
    const branch = ref.replace('refs/heads/', '');

    // Fetch main branch and generate diff
    await fetchMainBranch();
    const diff = await generateDiff();

    // If no diff, output a message and exit
    if (!diff) {
      core.setOutput('feedback', 'No differences found.');
      core.info('No differences found between main and current branch.');
      return;
    }

    // Generate AI feedback (using the new chat.completions.create method)
    const feedback = await generateFeedback(openai, openaiModel, diff);

    // Find the pull request
    const prNumber = await findOpenPullRequest(octokit, branch);
    if (!prNumber) {
      core.warning('Cannot proceed without an open PR.');
      return;
    }

    // Check for existing bot comment
    const botComment = await findExistingBotComment(octokit, prNumber);

    // Create or update the bot comment with the AI feedback
    await updateOrCreateBotComment(octokit, prNumber, botComment, feedback);

    core.info('Comment posted successfully.');
  } catch (error: unknown) {
    // Updated error handling for OpenAI v4
    if (error instanceof OpenAI.APIError) {
      core.error(`OpenAI API Error: ${error.message}`);
      core.error(`Status: ${error.status}`);
      core.error(`Code: ${error.code}`);
      core.error(`Type: ${error.type}`);
    } else {
      core.error(`Non-API error: ${(error as Error).message}`);
    }

    core.setFailed(`An error occurred: ${(error as Error).message}`);
  }
}

// Execute the main function
main();