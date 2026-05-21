//! Structured content extraction from HTML pages.
//!
//! Uses `scraper` for DOM traversal and content extraction.
//! Operates on sanitized HTML only — never raw web content.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScrapedPage {
    pub title: String,
    pub url: String,
    pub headings: Vec<Heading>,
    pub paragraphs: Vec<String>,
    pub code_blocks: Vec<CodeBlock>,
    pub links: Vec<Link>,
    pub tables: Vec<TableData>,
    pub lists: Vec<ListData>,
    pub meta_description: Option<String>,
    pub language: Option<String>,
    pub reading_time_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Heading {
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeBlock {
    pub language: Option<String>,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub text: String,
    pub href: String,
    pub rel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableData {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListData {
    pub ordered: bool,
    pub items: Vec<String>,
}

impl ScrapedPage {
    pub fn from_html(html: &str, url: &str) -> Self {
        let document = scraper::Html::parse_document(html);
        let title = extract_title(&document);
        let meta_description = extract_meta(&document, "description");
        let language = extract_meta(&document, "language");

        let headings = extract_headings(&document);
        let paragraphs = extract_paragraphs(&document);
        let code_blocks = extract_code_blocks(&document);
        let links = extract_links(&document);
        let tables = extract_tables(&document);
        let lists = extract_lists(&document);

        let word_count: usize = paragraphs.iter().map(|p| p.split_whitespace().count()).sum();
        let reading_time_seconds = ((word_count as f32 / 200.0) * 60.0).ceil() as u32;

        Self {
            title,
            url: url.to_string(),
            headings,
            paragraphs,
            code_blocks,
            links,
            tables,
            lists,
            meta_description,
            language,
            reading_time_seconds,
        }
    }

    pub fn to_text(&self) -> String {
        let mut lines = Vec::new();
        if !self.title.is_empty() {
            lines.push(format!("# {}", self.title));
            lines.push(String::new());
        }
        for h in &self.headings {
            let prefix = "#".repeat(h.level as usize);
            lines.push(format!("{prefix} {}", h.text));
        }
        lines.push(String::new());
        for p in &self.paragraphs {
            if !p.is_empty() {
                lines.push(p.clone());
                lines.push(String::new());
            }
        }
        if !self.code_blocks.is_empty() {
            lines.push("## Code Examples".to_string());
            for cb in &self.code_blocks {
                if let Some(lang) = &cb.language {
                    lines.push(format!("```{}", lang));
                } else {
                    lines.push("```".to_string());
                }
                lines.push(cb.code.clone());
                lines.push("```".to_string());
                lines.push(String::new());
            }
        }
        lines.into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
    }

    pub fn summary(&self, max_len: usize) -> String {
        let text = self.to_text();
        if text.chars().count() <= max_len {
            return text;
        }
        text.chars().take(max_len).collect::<String>() + "..."
    }
}

fn extract_title(doc: &scraper::Html) -> String {
    doc.select(&scraper::Selector::parse("title").unwrap())
        .next()
        .map(|el| el.text().collect::<String>().trim().to_string())
        .unwrap_or_default()
}

fn extract_meta(doc: &scraper::Html, name: &str) -> Option<String> {
    let selector_str = format!(r#"meta[name="{name}" i]"#);
    doc.select(&scraper::Selector::parse(&selector_str).unwrap())
        .next()
        .and_then(|el| el.value().attr("content"))
        .map(|s| s.trim().to_string())
}

fn extract_headings(doc: &scraper::Html) -> Vec<Heading> {
    let mut headings = Vec::new();
    for lvl in 1..=6 {
        let selector = scraper::Selector::parse(&format!("h{}", lvl)).unwrap();
        for el in doc.select(&selector) {
            let text = el.text().collect::<String>().trim().to_string();
            if !text.is_empty() {
                headings.push(Heading { level: lvl, text });
            }
        }
    }
    headings
}

fn extract_paragraphs(doc: &scraper::Html) -> Vec<String> {
    let selector = scraper::Selector::parse("p").unwrap();
    doc.select(&selector)
        .map(|el| el.text().collect::<String>().trim().to_string())
        .filter(|s| !s.is_empty() && s.len() > 20)
        .collect()
}

fn extract_code_blocks(doc: &scraper::Html) -> Vec<CodeBlock> {
    let mut blocks = Vec::new();

    let pre_selector = scraper::Selector::parse("pre code").unwrap();
    for el in doc.select(&pre_selector) {
        let lang = el.value().attr("class")
            .and_then(|class| class.strip_prefix("language-"))
            .map(ToString::to_string);
        let code = el.text().collect::<String>();
        if !code.trim().is_empty() {
            blocks.push(CodeBlock { language: lang, code });
        }
    }

    let code_selector = scraper::Selector::parse("pre").unwrap();
    for el in doc.select(&code_selector) {
        let existing = blocks.iter().any(|b| {
            doc.select(&code_selector)
                .any(|sel| sel.text().collect::<String>() == b.code)
        });
        if !existing {
            let code = el.text().collect::<String>();
            if !code.trim().is_empty() && code.len() > 20 {
                blocks.push(CodeBlock { language: None, code });
            }
        }
    }

    blocks
}

fn extract_links(doc: &scraper::Html) -> Vec<Link> {
    let selector = scraper::Selector::parse("a[href]").unwrap();
    doc.select(&selector)
        .filter_map(|el| {
            let href = el.value().attr("href")?;
            let text = el.text().collect::<String>().trim().to_string();
            if text.is_empty() || !href.starts_with("http") {
                return None;
            }
            let rel = el.value().attr("rel").map(ToString::to_string);
            Some(Link { text, href: href.to_string(), rel })
        })
        .take(200)
        .collect()
}

fn extract_tables(doc: &scraper::Html) -> Vec<TableData> {
    let selector = scraper::Selector::parse("table").unwrap();
    doc.select(&selector)
        .filter_map(|table| {
            let headers: Vec<String> = table
                .select(&scraper::Selector::parse("thead th").unwrap())
                .map(|el| el.text().collect::<String>().trim().to_string())
                .collect();

            let rows: Vec<Vec<String>> = table
                .select(&scraper::Selector::parse("tbody tr").unwrap())
                .map(|row| {
                    row.select(&scraper::Selector::parse("td").unwrap())
                        .map(|el| el.text().collect::<String>().trim().to_string())
                        .collect()
                })
                .filter(|row: &Vec<String>| !row.is_empty())
                .collect();

            if headers.is_empty() && rows.is_empty() {
                return None;
            }
            Some(TableData { headers, rows })
        })
        .take(20)
        .collect()
}

fn extract_lists(doc: &scraper::Html) -> Vec<ListData> {
    let mut lists = Vec::new();

    for (ordered, selector_str) in [(false, "ul"), (true, "ol")] {
        let selector = scraper::Selector::parse(selector_str).unwrap();
        for el in doc.select(&selector) {
            let items: Vec<String> = el
                .select(&scraper::Selector::parse("li").unwrap())
                .map(|li| li.text().collect::<String>().trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !items.is_empty() {
                lists.push(ListData { ordered, items });
            }
        }
    }

    lists
}

pub struct PageScraper;

impl PageScraper {
    pub fn scrape(html: &str, url: &str) -> ScrapedPage {
        ScrapedPage::from_html(html, url)
    }
}