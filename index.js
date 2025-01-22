const core = require('@actions/core');
const github = require('@actions/github');
const { exec } = require('child_process');
const { Configuration, OpenAIApi } = require('openai');
const util = require('util');

const execAsync = util.promisify(exec);

async function main() {
  try {
    // Retrieve inputs
    const githubToken = core.getInput('github_token', { required: true });
    const openaiToken = core.getInput('openai_token', { required: true });
    const openaiModel = core.getInput('openai_model') || 'gpt-3.5-turbo';

    // Set up clients
    const octokit = github.getOctokit(githubToken);
    const configuration = new Configuration({
      apiKey: openaiToken,
    });
    const openai = new OpenAIApi(configuration);

    // Get the current branch
    const ref = github.context.ref; // e.g., "refs/heads/feature-branch"
    if (!ref || !ref.startsWith('refs/heads/')) {
      throw new Error(`GITHUB_REF is not a valid branch reference: ${ref}`);
    }
    const branch = ref.replace('refs/heads/', '');

    // Fetch main branch and generate diff
    core.info('Fetching latest code from main...');
    await execAsync('git fetch origin main');

    core.info('Generating diff...');
    const { stdout: diff, stderr } = await execAsync(`git diff --inter-hunk-context=1000 origin/main...HEAD`);

    if (stderr) {
      core.warning(`Standard error while generating diff: ${stderr}`);
    }

    if (!diff) {
      core.setOutput('feedback', 'No differences found.');
      core.info('No differences found between main and current branch.');
      return;
    }

    // Prepare the prompt for OpenAI
    core.info('Generating feedback from OpenAI...');
    const userPrompt = `Check this PR code, find logic issues not easily found by static analysis tools, order them by severity.\n\nPlease review the following diff:\n${diff}\n`;

    const response = await openai.createChatCompletion({
      model: openaiModel,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const feedback = response.data.choices[0].message.content.trim();

    // Find the pull request
    core.info(`Searching for open PR for branch '${branch}'...`);
    const { data: pullRequests } = await octokit.rest.pulls.list({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      head: `${github.context.repo.owner}:${branch}`,
      state: 'open',
    });

    if (pullRequests.length === 0) {
      core.warning(`No open PR found for branch '${branch}'. Exiting...`);
      return;
    }

    const prNumber = pullRequests[0].number;
    core.info(`Found PR #${prNumber}.`);

    // Check for existing bot comment
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: prNumber,
    });

    const botComment = comments.find(
      (comment) =>
        comment.user.type === 'Bot' && comment.body.includes('<!-- GPT-BOT-COMMENT -->')
    );

    const commentBody = `<!-- GPT-BOT-COMMENT -->\n${feedback}`;

    if (botComment) {
      // Update existing comment
      core.info('Updating existing bot comment...');
      await octokit.rest.issues.updateComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        comment_id: botComment.id,
        body: commentBody,
      });
    } else {
      // Create new comment
      core.info('Creating new bot comment...');
      await octokit.rest.issues.createComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: prNumber,
        body: commentBody,
      });
    }

    core.info('Comment posted successfully.');
  } catch (error) {
    core.setFailed(`An error occurred: ${error.message}`);
  }
}

main();