import sys

from openai import OpenAI


def main():
    diff_file = sys.argv[1]
    output_file = sys.argv[2]
    openai_api_key = sys.argv[3]
    model_name = sys.argv[4]

    with open(diff_file) as f:
        diff_contents = f.read()

    client = OpenAI(api_key=openai_api_key)

    user_prompt = (
        "Check this PR code, find logic issues that are not easily found by SonarQube, order them by severity.\n"
        f"Please review the following diff:\n{diff_contents}\n\n"
    )

    response = client.chat.completions.create(
        model=model_name, messages=[{"role": "user", "content": user_prompt}],
    )

    feedback = response.choices[0].message.content.strip()

    with open(output_file, "w") as f:
        f.write(feedback)


if __name__ == "__main__":
    main()
