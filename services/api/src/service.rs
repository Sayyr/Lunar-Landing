use std::sync::Arc;

use serde_json::Value;

use crate::{
    config::{ProfilesConfig, Step},
    error::AppError,
    model::{Coordinates, EastWest, NorthSouth, SiteQuery},
    repository::CalculatorRepository,
};

pub struct Plan {
    pub coordinates: Coordinates,
    pub profile: String,
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone)]
pub struct SiteService {
    config: Arc<ProfilesConfig>,
    repository: CalculatorRepository,
}

impl SiteService {
    pub fn new(config: ProfilesConfig, repository: CalculatorRepository) -> Self {
        Self {
            config: Arc::new(config),
            repository,
        }
    }

    pub fn prepare(&self, query: &SiteQuery) -> Result<Plan, AppError> {
        let coordinates = validate(query)?;
        let (profile, steps) = self.config.resolve(query.profile.as_deref())?;
        Ok(Plan {
            coordinates,
            profile,
            steps,
        })
    }

    pub async fn run(&self, step: &Step, coordinates: Coordinates) -> Result<Value, AppError> {
        self.repository.run(&step.command, coordinates).await
    }
}

fn validate(query: &SiteQuery) -> Result<Coordinates, AppError> {
    if !(0.0..=90.0).contains(&query.lat) {
        return Err(AppError::Validation(format!(
            "lat must be between 0 and 90, got {}",
            query.lat
        )));
    }
    if !(0.0..=180.0).contains(&query.lon) {
        return Err(AppError::Validation(format!(
            "lon must be between 0 and 180, got {}",
            query.lon
        )));
    }
    if !query.height.is_finite() {
        return Err(AppError::Validation(
            "height must be a finite number".into(),
        ));
    }

    let lat = match query.ns {
        NorthSouth::N => query.lat,
        NorthSouth::S => -query.lat,
    };
    let lon = match query.ew {
        EastWest::E => query.lon,
        EastWest::W => -query.lon,
    };

    Ok(Coordinates {
        lat,
        lon,
        height: query.height,
    })
}
