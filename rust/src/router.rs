//! Router — ContentType → Compressor map with a Verbatim default.

use std::collections::HashMap;

use crate::classifier::ContentType;
use crate::compressors::verbatim::Verbatim;
use crate::compressors::Compressor;

pub struct Router {
    routes: HashMap<ContentType, Box<dyn Compressor>>,
    default: Box<dyn Compressor>,
}

impl Default for Router {
    fn default() -> Self {
        Router { routes: HashMap::new(), default: Box::new(Verbatim) }
    }
}

impl Router {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, content_type: ContentType, compressor: Box<dyn Compressor>) {
        self.routes.insert(content_type, compressor);
    }

    pub fn route(&self, content_type: ContentType) -> &dyn Compressor {
        self.routes
            .get(&content_type)
            .map(|b| b.as_ref())
            .unwrap_or(self.default.as_ref())
    }
}
