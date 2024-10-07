import { requestUrl } from "obsidian";
export class ChatGPT {
	private static baseUrl = 'https://api.openai.com/v1/chat/completions';

	static async callAPI(
		system_role: string,
		user_prompt: string,
		apiKey: string,
		abortSignal: AbortSignal,
		model: string = 'gpt-3.5-turbo',
		max_tokens: number = 150,
		temperature: number = 0,
		top_p: number = 0.95,
		frequency_penalty: number = 0,
		presence_penalty: number = 0.5,
		retries = 5,
	): Promise<string> {

		const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

		const headers = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		};

		const body = JSON.stringify({
			model: model,
			messages: [
				{ "role": "system", "content": system_role },
				{ "role": "user", "content": user_prompt },
			],
			max_tokens: max_tokens,
			n: 1,
			// stop: '\n',
			stop: null,
			temperature: temperature,
			top_p: top_p,
			frequency_penalty: frequency_penalty,
			presence_penalty: presence_penalty
		});

		for (let attempt = 0; attempt < retries; attempt++) {
			if (abortSignal.aborted) {
				throw new Error('Aborted');
			}
			try {
				const response = await requestUrl({
					url: this.baseUrl,
					method: 'POST',
					headers: headers,
					body: body,
				});
				const data = JSON.parse(response.text);
				return data.choices[0].message.content;
			} catch (error) {
				console.error(error);
				if (error.status === 429) {
					const waitTime = Math.pow(2, attempt) * 2000;
					console.log(`Retrying in ${waitTime}ms...`);
					await delay(waitTime);
				} else {
					break;
				}
			}
		}
		throw new Error("Max retries reached. Unable to complete the request.");
	}
}
