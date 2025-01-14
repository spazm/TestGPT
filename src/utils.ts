import chalk from "chalk";
import fs from "fs";
import path from "path";
import { Configuration, CreateChatCompletionRequest, OpenAIApi } from "openai";
import { parse } from "yaml";
import { ERole, IExample, IMessage, iGetPromptArgs } from "./types";

export const readFile = (path: string) => {
  try {
    const fileContent: string = fs.readFileSync(path, "utf-8");
    return fileContent;
  } catch (err) {
    console.error(`Error reading file: ${err}`);
    return "";
  }
};

export const writeToFile = (
  path: string,
  content: string,
  append?: boolean
) => {
  try {
    fs.writeFileSync(path, content, {
      flag: append ? "a" : "w",
    });
    console.log(chalk.green(`Successfully wrote to file: ${path}`));
  } catch (err) {
    console.error(`Error writing to file: ${err}`);
  }
};

export const divideFileName = (fileName: string) => {
  const extension = path.extname(fileName);
  const name = path.basename(fileName, extension);

  return { name, extension };
};

export enum EFileType {
  File,
  Directory,
}

export const getFileType = (path: string) => {
  try {
    const isDirectory = fs.lstatSync(path).isDirectory();

    return isDirectory ? EFileType.Directory : EFileType.File;
  } catch (err) {
    console.error(`Error getting file type: ${err}`);
    return EFileType.File;
  }
};

export const toList = (arr: string[]) =>
  arr.map((tip, index) => `${index + 1}. ${tip}`).join("\r\n");

export const getPrompt = ({
  content,
  fileName,
  techs,
  tips,
}: iGetPromptArgs) => {
  let prompt = `I need unit tests for a file called ${fileName}`;

  if (techs?.length) {
    prompt += ` using the following technologies: 
      ${toList(techs)}
    `;
  }

  if (tips?.length) {
    prompt += `Here are some tips: 
      ${toList(tips)}
    `;
  }

  prompt +=
    "Your answer should be only the code block. Start your response with ``` directly and end it with ``` only, don't add any more text.";

  prompt += `Here is the file content: 
    \`\`\`
    ${content}
    \`\`\`
  `;

  return prompt;
};

export const getExampleMessages = (
  promptArgs: iGetPromptArgs,
  examples?: IExample[]
) => {
  if (!examples) {
    return [];
  }

  const messages = examples
    .map((g) => {
      const prompt = getPrompt({
        ...promptArgs,
        content: g.code,
        fileName: g.fileName,
      });

      return [
        {
          role: ERole.User,
          content: prompt,
        },
        {
          role: ERole.Assistant,
          content: g.tests,
        },
      ];
    })
    .flat();

  return messages as IMessage[];
};

export const readYamlFile = (path: string) => {
  const content = readFile(path);
  return parse(content);
};

export type IModel = "gpt-3.5-turbo" | "gpt-3.5-turbo-0301" | "gpt-4";

export const initOpenAI = async (apiKey: string) => {
  const configuration = new Configuration({
    apiKey: apiKey,
  });

  const openai = new OpenAIApi(configuration);

  return openai;
};

export type ICompletionRequest = CreateChatCompletionRequest;

export const getCompletionRequest = (
  model: IModel,
  prompt: string,
  examples: IMessage[]
) => {
  return {
    model,
    messages: [
      {
        role: ERole.System,
        content:
          "You are an assistant that provides unit tests for a given file.",
      },
      ...examples,
      {
        role: ERole.User,
        content: prompt,
      },
    ],
  } as ICompletionRequest;
};

export const getTestContent = async (
  completionRequest: ICompletionRequest,
  openai: OpenAIApi
) => {
  const response = await openai.createChatCompletion(completionRequest);

  // remove lines that start with ``` (markdown code block)
  const regex = /^```.*$/gm;
  return response.data.choices[0].message.content?.replace(regex, "");
};

export const streamTestContent = async (
  completionRequest: ICompletionRequest,
  openai: OpenAIApi,
  onToken: (token: string) => void
) => {
  const response = await openai.createChatCompletion(
    {
      ...completionRequest,
      stream: true,
    },
    {
      responseType: "stream",
    }
  );

  for await (const chunk of (response as any).data) {
    const lines = chunk
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith("data: "));

    for (const line of lines) {
      const message = line.replace(/^data: /, "");

      if (message === "[DONE]") {
        return;
      }

      const json = JSON.parse(message);
      const token = json.choices[0].delta.content;

      if (token) {
        onToken(token);
      }
    }
  }
};

interface IAutoTestArgs {
  inputFile: string;
  outputFile: string;
  apiKey: string;
  model: IModel;
  examples?: IExample[];
  techs?: string[];
  tips?: string[];
  stream?: boolean;
}

export const autoTest = async ({
  inputFile,
  outputFile,
  apiKey,
  model,
  examples,
  techs,
  tips,
  stream,
}: IAutoTestArgs) => {
  console.log(chalk.blue("Reading input file..."));

  let content: string;
  try {
    content = readFile(inputFile);
  } catch (err) {
    console.error(chalk.red(`Error reading file: ${err}`));
    process.exit(1);
  }

  console.log(chalk.blue("Generating tests..."));

  const openai = await initOpenAI(apiKey);

  const promptArgs = {
    content,
    fileName: inputFile,
    techs,
    tips,
  };

  const prompt = getPrompt(promptArgs);
  const exampleMessages = getExampleMessages(promptArgs, examples);
  const completionRequest = getCompletionRequest(
    model,
    prompt,
    exampleMessages
  );

  if (stream) {
    await streamTestContent(completionRequest, openai, (token) => {
      writeToFile(outputFile, token, true);
    });
  } else {
    const testContent = await getTestContent(completionRequest, openai);
    writeToFile(outputFile, testContent);
  }
};
