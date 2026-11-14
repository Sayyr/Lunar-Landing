use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;

use crate::error::AppError;

#[derive(Debug, Clone)]
pub struct Step {
    pub name: String,
    pub command: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfilesFile {
    default: String,
    profiles: HashMap<String, Vec<String>>,
}

#[derive(Debug)]
pub struct ProfilesConfig {
    default: String,
    profiles: HashMap<String, Vec<String>>,
    scripts_dir: PathBuf,
}

impl ProfilesConfig {
    pub fn load(path: &Path, scripts_dir: PathBuf) -> Result<Self, String> {
        let content = fs::read_to_string(path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        let file: ProfilesFile = serde_json::from_str(&content)
            .map_err(|error| format!("invalid {}: {error}", path.display()))?;
        let config = Self {
            default: file.default,
            profiles: file.profiles,
            scripts_dir,
        };
        config.check()?;
        Ok(config)
    }

    fn check(&self) -> Result<(), String> {
        if !self.profiles.contains_key(&self.default) {
            return Err(format!("default profile '{}' is not defined", self.default));
        }
        for (profile, scripts) in &self.profiles {
            if scripts.is_empty() {
                return Err(format!("profile '{profile}' has no script"));
            }
            for script in scripts {
                if script.is_empty() || script.contains('/') || script.contains("..") {
                    return Err(format!("profile '{profile}': invalid script name '{script}'"));
                }
                let command = self.scripts_dir.join(script);
                if !command.is_file() {
                    return Err(format!(
                        "profile '{profile}': {} not found",
                        command.display()
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn resolve(&self, profile: Option<&str>) -> Result<(String, Vec<Step>), AppError> {
        let name = profile.unwrap_or(self.default.as_str());
        let scripts = self.profiles.get(name).ok_or_else(|| {
            let mut available: Vec<&str> = self.profiles.keys().map(String::as_str).collect();
            available.sort();
            AppError::Validation(format!(
                "unknown profile '{name}', available: {}",
                available.join(", ")
            ))
        })?;
        let steps = scripts
            .iter()
            .map(|script| Step {
                name: script.clone(),
                command: self.scripts_dir.join(script),
            })
            .collect();
        Ok((name.to_string(), steps))
    }
}
