import { Plugin, Notice } from "obsidian";
import { AutoClassifierSettingTab, AutoClassifierSettings, DEFAULT_SETTINGS, OutLocation, OutType} from "src/settings";
import { ViewManager } from "src/view-manager";
import { ChatGPT } from 'src/api';

enum InputType {
	SelectedArea,
	Title,
	FrontMatter,
	Content,
	CalloutContent,
}

export default class AutoClassifierPlugin extends Plugin {
	settings: AutoClassifierSettings;
	viewManager = new ViewManager(this.app);
	abortController: AbortController;

	async onload() {
		await this.loadSettings();
		this.abortController = new AbortController();

		// Commands
		this.addCommand({
			id: 'classify-tag-selected',
			name: 'Classify tag from Selected Area',
			callback: async () => {
				await this.runClassifyTag(InputType.SelectedArea);
			}
		});
		this.addCommand({
			id: 'classify-tag-title',
			name: 'Classify tag from Note Title',
			callback: async () => {
				await this.runClassifyTag(InputType.Title);
			}
		});
		this.addCommand({
			id: 'classify-tag-frontmatter',
			name: 'Classify tag from FrontMatter',
			callback: async () => {
				await this.runClassifyTag(InputType.FrontMatter);
			}
		});
		this.addCommand({
			id: 'classify-tag-content',
			name: 'Classify tag from Note Content',
			callback: async () => {
				await this.runClassifyTag(InputType.Content);
			}
		});
		this.addCommand({
			id: 'classify-tag-callout-content',
			name: 'Classify tag from Callouts in Note Content',
			callback: async () => {
				await this.runClassifyTag(InputType.CalloutContent);
			}
		});

		this.addCommand({
			id: 'abort-classification',
			name: 'Abort classification',
			callback: () => {
				this.abortClassification();
			}
		});

		this.addSettingTab(new AutoClassifierSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
	}

	async onunload() {
		this.abortController.abort();
	}

	abortClassification() {
		new Notice(`⛔ ${this.manifest.name}: aborting...`);
		this.abortController.abort();
		this.abortController = new AbortController();
	}

	async runClassifyTag(inputType: InputType) {
		const loadingNotice = this.createLoadingNotice(`${this.manifest.name}: Processing..`, 0);
		const signal = this.abortController.signal
		try {
			await this.classifyTag(inputType, signal);
			loadingNotice.hide();
		} catch (err) {
			loadingNotice.hide();
		}
	}

	async createNoteIfNotExist(noteTitle: string) {
		const note = this.app.vault.getAbstractFileByPath(`${noteTitle}.md`);

		// Check if the note already exists
		if (!note) {
			// Create a new file with the name `linkText.md`
			await this.app.vault.create(`${noteTitle}.md`, `# ${noteTitle}\n\n`);
			console.log(`Created note: ${noteTitle}`);
		}
	}
	// Main Classification
	async classifyTag(inputType: InputType, signal: AbortSignal) {
		const commandOption = this.settings.commandOption;
		// ------- [API Key check] -------
		if (!this.settings.apiKey) {
			new Notice(`⛔ ${this.manifest.name}: You should input your API Key`);
			return null
		}
		// ------- [Input] -------
		const refs = commandOption.refs;
		// reference check
		if (commandOption.useRef && (!refs || refs.length == 0)) {
			new Notice(`⛔ ${this.manifest.name}: no reference tags`);
			return null
		}

		// Set Input 
		let inputs: string[] | null = [''];
		if (inputType == InputType.SelectedArea) {
			inputs = await this.viewManager.getSelection();
		}
		else if (inputType == InputType.Title) {
			inputs = await this.viewManager.getTitle();
		}
		else if (inputType == InputType.FrontMatter) {
			inputs = await this.viewManager.getFrontMatter();
		}
		else if (inputType == InputType.Content) {
			inputs = await this.viewManager.getContent();
		}
		else if (inputType == InputType.CalloutContent) {
			inputs = await this.viewManager.getCalloutContent();
		}

		// input error
		if (!inputs) {
			new Notice(`⛔ ${this.manifest.name}: no input data`);
			return null;
		}

		for (let input of inputs) {
			// input error
			if (!input) {
				new Notice(`⛔ ${this.manifest.name}: no input data`);
				return null;
			}

			// Replace {{input}}, {{reference}}
			let user_prompt = commandOption.prmpt_template;
			user_prompt = user_prompt.replace('{{input}}', input);
			user_prompt = user_prompt.replace('{{reference}}', refs.join(','));
			user_prompt = user_prompt.replace('{{max_tags}}', commandOption.max_tags === 0 ? 'unlimited' : commandOption.max_tags.toString());

			const system_role = commandOption.chat_role;

			// ------- [API Processing] -------
			// Call API
			let responseRaw;
			try {
				responseRaw = await ChatGPT.callAPI(
					system_role, 
					user_prompt, 
					this.settings.apiKey,
					signal,
					this.settings.commandOption.model,
					this.settings.commandOption.max_tokens,
				);
				if (!responseRaw) {
					new Notice(`⛔ ${this.manifest.name}: empty API response`);
					return null;
				}
			} catch (error) {
				new Notice(`⛔ ${this.manifest.name}: API error (output ${error})`);
				return null;
			}
			let jsonList;
			try {
				jsonList = JSON.parse(responseRaw);
				if (!Array.isArray(jsonList)) {
					throw new Error();
				}
			} catch (error) {
				console.error(error);
				const errorString = `⛔ ${this.manifest.name}: output format error (output: ${responseRaw})`;
				console.error(errorString);
				new Notice(errorString);
				return null;
			}
			let tagString = ' #auto-classifier ';
			for (let response of jsonList) {
				if (!response || !response.reliability || !response.output) {
					new Notice(`⛔ ${this.manifest.name}: response format error`);
					return;
				}
				// Avoid low reliability
				if (response.reliability <= 0.2) {
					new Notice(`⛔ ${this.manifest.name}: response has low reliability (${response.reliability})`);
					return;
				}
				const outputName = response.output + '-GPT';
				const output = this.viewManager.preprocessOutput(outputName, commandOption.outType, commandOption.outPrefix, commandOption.outSuffix);
				await this.createNoteIfNotExist(outputName);
				tagString += output + ' '
			}

			// ------- [Add Tag] -------
			// Output Type 1. [Tag Case] + Output Type 2. [Wikilink Case]
			if (commandOption.outType == OutType.Tag || commandOption.outType == OutType.Wikilink) {
				if (commandOption.outLocation == OutLocation.Cursor) {
					await this.viewManager.insertAtCursor(tagString, commandOption.overwrite);
				} 
				else if (commandOption.outLocation == OutLocation.ContentTop) {
					await this.viewManager.insertAtContentTop(tagString);
				}
				else if (commandOption.outLocation == OutLocation.CalloutTop) {
					await this.viewManager.insertAtCalloutTop(input, tagString);
				}
			}
			// Output Type 3. [Frontmatter Case]
			else if (commandOption.outType == OutType.FrontMatter) {
				await this.viewManager.insertAtFrontMatter(commandOption.key, tagString, commandOption.overwrite, commandOption.outPrefix, commandOption.outSuffix);
			}
			// Output Type 4. [Title]
			else if (commandOption.outType == OutType.Title) {
				await this.viewManager.insertAtTitle(tagString, commandOption.overwrite, commandOption.outPrefix, commandOption.outSuffix);
			}
			new Notice(`✅ ${this.manifest.name}: classified to ${tagString}`);
		}
	}

	// create loading spin in the Notice message
	createLoadingNotice(text: string, number = 10000): Notice {
		const notice = new Notice('', number);
		const loadingContainer = document.createElement('div');
		loadingContainer.addClass('loading-container');

		const loadingIcon = document.createElement('div');
		loadingIcon.addClass('loading-icon');
		const loadingText = document.createElement('span');
		loadingText.textContent = text;
		//@ts-ignore
		notice.noticeEl.empty();
		loadingContainer.appendChild(loadingIcon);
		loadingContainer.appendChild(loadingText);
		//@ts-ignore
		notice.noticeEl.appendChild(loadingContainer);

		return notice;
	}
}


