use std::path::Path;

use serde_json::Value;
use tokio::process::Command;

use crate::{error::AppError, model::Coordinates};

#[derive(Debug, Clone, Default)]
pub struct CalculatorRepository;

impl CalculatorRepository {
    pub async fn run(&self, command: &Path, coordinates: Coordinates) -> Result<Value, AppError> {
        let output = Command::new(command)
            .arg(coordinates.lat.to_string())
            .arg(coordinates.lon.to_string())
            .arg(coordinates.height.to_string())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|error| {
                AppError::Calculator(format!("cannot start {}: {error}", command.display()))
            })?;

        if !output.status.success() {
            return Err(AppError::Calculator(format!(
                "calculator failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }

        let value: Value = serde_json::from_slice(&output.stdout)
            .map_err(|error| AppError::Calculator(format!("invalid calculator output: {error}")))?;
        if !value.is_object() {
            return Err(AppError::Calculator(
                "calculator output must be a JSON object".into(),
            ));
        }
        Ok(value)
    }
}
