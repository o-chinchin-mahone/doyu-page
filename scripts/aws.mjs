import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { REGION } from "./config.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const notFound = (e) =>
  ["ResourceNotFoundException", "NoSuchEntityException", "NoSuchEntity", "NotFoundException"].includes(e.name);

export async function accountId() {
  return (await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}))).Account;
}

// 存在しなければ create を呼ぶ。戻り値は get / create の結果
export async function ensure(get, create) {
  try {
    return { value: await get(), created: false };
  } catch (e) {
    if (!notFound(e)) throw e;
    return { value: await create(), created: true };
  }
}

export async function attempt(label, fn) {
  try { await fn(); console.log(`✓ ${label}`); }
  catch (e) { console.log(`- ${label}: ${e.name}`); }
}

export const trustPolicy = (principal) => JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: principal }, Action: "sts:AssumeRole" }],
});
