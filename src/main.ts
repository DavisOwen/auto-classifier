import { Plugin, Notice, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import { AutoClassifierSettingTab, AutoClassifierSettings, DEFAULT_SETTINGS, OutLocation, OutType, CommandOption} from "src/settings";
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
			id: 'classify-tag-callout-content-whole-vault',
			name: 'Classify tag from Callouts in Note Content for Every File in Vault',
			callback: async () => {
				await this.runClassifyTag(InputType.CalloutContent, true);
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

	async runClassifyTag(inputType: InputType, wholeVault: boolean = false) {
		const loadingNotice = this.createLoadingNotice(`${this.manifest.name}: Processing..`, 0);
		const signal = this.abortController.signal
		try {
			await this.classifyTag(inputType, signal, wholeVault);
			loadingNotice.hide();
		} catch (err) {
			console.error(err);
			loadingNotice.hide();
		}
	}

	async createNoteIfNotExist(noteTitle: string) {
		try {
			const note = this.app.vault.getAbstractFileByPath(`Topics/GPT/${noteTitle}.md`);

			// Check if the note already exists
			if (!note) {
				// Create a new file with the name `linkText.md`
				await this.app.vault.create(`Topics/GPT/${noteTitle}.md`, '');
				console.log(`Created note: ${noteTitle}`);
			}
		} catch (err) {
			if (err.message.includes('File already exists')) {
				// Do nothing if the file already exists
				console.warn(`File already exists: ${noteTitle}.md`);
			} else {
				throw err;
			}
		}
	}

	async closeLeaf(leaf: WorkspaceLeaf) {
		if (leaf) {
			leaf.detach();
		}
	}

	async classifyFile(
		inputType: InputType,
		file: TFile,
		wholeVault: boolean,
		commandOption: CommandOption,
		refs: string[],
		signal: AbortSignal
	) {
		console.debug(`${this.manifest.name}: classifying file:${file.name}`)
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
			if (!wholeVault) {
				console.warn(`$this.manifest.name}: no input data for file: ${file.name}`);
			}
			return
		}

		for (let input of inputs) {
			// input error
			if (!input) {
				console.warn(`Empty input data while processing ${file.name}`)
				continue
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
					console.warn(`${this.manifest.name}: Empty API response for input:${input} in file:${file.name}`)
					continue
				}
			} catch (error) {
				console.warn(`${this.manifest.name}: API error processing input:${input} in file ${file.name}. (output: ${error})`)
				continue
			}
			let jsonList;
			try {
				jsonList = JSON.parse(responseRaw);
				if (!Array.isArray(jsonList)) {
					console.warn(`${this.manifest.name}: API response from input:${input} in file ${file.name} is not proper JSON`)
					continue
				}
			} catch (error) {
				console.warn(`${this.manifest.name}: Output format error for input:${input} in file ${file.name} (output: ${responseRaw}). Error: ${error}`);
				continue
			}
			let tagString = ' #auto-classifier ';
			for (let response of jsonList) {
				if (!response || !response.reliability || !response.output) {
					console.warn(`${this.manifest.name}: API response from input:${input} in file ${file.name} is not expected format`)
					continue
				}
				// Avoid low reliability
				if (response.reliability <= 0.2) {
					console.warn(`${this.manifest.name}: Output: ${response.output} from input:${input} in file ${file.name} has low reliability: ${response.reliability}, skipping...`)
					continue;
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
			console.debug(`${this.manifest.name}: Input: ${input} in file ${file.name} classified to ${tagString}`);
		}
	}

	// Main Classification
	async classifyTag(inputType: InputType, signal: AbortSignal, wholeVault: boolean = false) {
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

		// All files in the vault, or just the current file
		const files = wholeVault ? this.app.vault.getMarkdownFiles() : [this.app.workspace.getActiveViewOfType(MarkdownView)?.file]

		for (const [index, file] of files.entries()) {
			if (signal.aborted) {
				throw new Error('Aborted')
			}

			if (!file) {
				console.warn(`${this.manifest.name}: undefined file found`);
			} else {
				// Open file in vault in new tab for processing - if wholeVault
				// is false, we should just stay in the existing file
				const leaf = this.app.workspace.getLeaf(true);
				await leaf.openFile(file);

				await this.classifyFile(
					inputType,
					file,
					wholeVault,
					commandOption,
					refs,
					signal
				);

				// Close tab when done
				this.closeLeaf(leaf);

				console.debug(`Progress ${(index + 1) * 100 / files.length}%`);
			}
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


