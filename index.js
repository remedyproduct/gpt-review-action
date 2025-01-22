const core = require('@actions/core');
const github = require('@actions/github');
const { exec } = require('child_process');
const { Configuration, OpenAIApi } = require('openai');
const util = require('util');

const execAsync = util.promisify(exec);

/**
 * Fetch the latest code from main branch.
 */
async function fetchMainBranch() {
  core.info('Fetching latest code from main...');
  await execAsync('git fetch origin main');
}

/**
 * Generate a diff between the main branch and the current HEAD.
 * Includes extended context to help with AI-based review.
 *
 * @returns {Promise<string>} The diff content.
 */
async function generateDiff() {
  core.info('Generating diff...');
  const { stdout, stderr } = await execAsync('git diff --inter-hunk-context=1000 origin/main...HEAD');
  if (stderr) {
    core.warning(`Standard error while generating diff: ${stderr}`);
  }
  return stdout;
}

/**
 * Create and return an OpenAI client instance.
 *
 * @param {string} openaiToken - The OpenAI API token.
 * @returns {OpenAIApi} An instance of OpenAIApi.
 */
function createOpenAIClient(openaiToken) {
  const configuration = new Configuration({ apiKey: openaiToken });
  return new OpenAIApi(configuration);
}

/**
 * Generate feedback using OpenAI, given a diff and a model name.
 *
 * @param {OpenAIApi} openai - The OpenAI client.
 * @param {string} model - The OpenAI model (e.g., 'gpt-3.5-turbo').
 * @param {string} diff - The diff content to analyze.
 * @returns {Promise<string>} AI-generated feedback.
 */
async function generateFeedback(openai, model, diff) {
  core.info('Generating feedback from OpenAI...');

  const userPrompt = `Check this PR code, find logic issues not easily found by static analysis tools, order them by severity.\n\nPlease review the following diff:\n${diff}\n`;

  const response = await openai.createChatCompletion({
    model,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return response.data.choices[0].message.content.trim();
}

/**
 * Find an open PR corresponding to a given branch.
 *
 * @param {ReturnType<typeof github.getOctokit>} octokit - The authenticated GitHub client.
 * @param {string} branch - The branch name to find a PR for.
 * @returns {Promise<number|null>} The PR number if found, otherwise null.
 */
async function findOpenPullRequest(octokit, branch) {
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
 * Find an existing bot comment marked with `<!-- GPT-BOT-COMMENT -->` in a given PR.
 *
 * @param {ReturnType<typeof github.getOctokit>} octokit - The authenticated GitHub client.
 * @param {number} prNumber - The pull request number.
 * @returns {Promise<object|null>} The existing comment object if found, otherwise null.
 */
async function findExistingBotComment(octokit, prNumber) {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: prNumber,
  });

  return comments.find(
    (comment) =>
      comment.user.type === 'Bot' && comment.body.includes('<!-- GPT-BOT-COMMENT -->')
  );
}

/**
 * Update or create a comment in a PR with the AI-generated feedback.
 *
 * @param {ReturnType<typeof github.getOctokit>} octokit - The authenticated GitHub client.
 * @param {number} prNumber - The pull request number.
 * @param {object|null} botComment - The existing bot comment object if found.
 * @param {string} feedback - The AI-generated feedback content.
 */
async function updateOrCreateBotComment(octokit, prNumber, botComment, feedback) {
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
 * Main function to orchestrate the entire process.
 */
async function main() {
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

    // Generate AI feedback
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
  } catch (error) {
    core.setFailed(`An error occurred: ${error.message}`);
  }
}

// Execute the main function
main();