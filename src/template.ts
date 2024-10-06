export const DEFAULT_CHAT_ROLE = `You are a JSON answer bot. Don't answer other words.`;
export const DEFAULT_PROMPT_TEMPLATE = `Classify this content:
"""
{{input}}
"""
Answer format is JSON Array [{reliability:0~1, output:selected_category}, ...]. 
Output {{max_tags}} tags, selected from the following list:

{{reference}}
`;

export const DEFAULT_PROMPT_TEMPLATE_WO_REF = `Classify this content:
"""
{{input}}
"""
Answer format is JSON {reliability:0~1, output:selected_category}. 
Even if you are not sure, qualify the reliability and recommend a proper category.

`;
