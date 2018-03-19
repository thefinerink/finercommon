const dbcmd = require('../../utils/dbcommand');
const md5 = require('md5');
const extend = require('extend');
const survey = require('../survey');
const SurveyValueExtractor = require('../surveyvalueextractor');
const ResponseCollection = require('../responsecollection');
const Response = require('../response');
const Respondent = require('../respondent');
const BuyX = require('../buyx');
const Approval = require('../approval');
const Survey = require('../survey');
const CRMOpportunities = require('../crmopportunities');

/**
 * Fix up labels to be more presentable
 * @param {*} str
 */
var ShortCleanupOnLabels = function (str) {
  if (str == "__other__") {
    return "Other";
  } else {
    if (str.indexOf("External") > -1 && str.indexOf("(") > -1) {
      return str
        .split("(")[0]
        .trim();
    } else if (str.indexOf("features") > -1) {
      return "Features";
    } else if (str.indexOf("_No Vendor Chosen") > -1) {
      return "None";
    }
  }
  return str;
};

/**
 * The general report class (ASYNC)
 * @param {*} cfg
 * @param {*} orgid
 * @param {*} startdate
 * @param {*} enddate
 */
var RunReportAsync = async function (cfg, orgid, startdate, enddate) {
  // This will hold the final result
  var resultObject = {};

  // Set up a survey value extractor
  let exter = new SurveyValueExtractor();

  // First get all the customer surveys
  let svs = await survey.GetForOrganizationAndTypeAsync(cfg, orgid, survey.SURVEY_TYPES.PROSPECT);

  // A flat array of respondents with their surveys
  let respondentArr = [];

  // Start computing buyX
  resultObject.buyX = 0;

  // First compute the buyX score for all responses
  for (let i = 0; i < svs.length; i++) {
    svs[i].respondents = await Respondent.GetBySurveyAndTimeRangeAsync(cfg, svs[i].guid, startdate, enddate);
    for (let j = 0; j < svs[i].respondents.length; j++) {
      svs[i].respondents[j].survey = svs[i];
      svs[i].respondents[j].buyX = BuyX.CalculateBuyXFromResponses(svs[i], svs[i].respondents[j].answers);
      respondentArr.push(svs[i].respondents[j]);
      resultObject.buyX += svs[i].respondents[j].buyX;
    }
  }

  // Only proceed if we have data
  if (respondentArr.length > 0) {
    resultObject.buyX /= respondentArr.length;
  }

  // Compute reasons for loss
  let reasonsForLoss = [];

  // Tally them up
  for (let i = 0; i < respondentArr.length; i++) {
    let resp = respondentArr[i],
      answers = resp.answers,
      surveymodel = resp.survey.survey_model;

    // Get the question definition from this survey for the key question
    let questionDef = exter._locateQuestionObjectForName("whyNotSelected", surveymodel.pages);

    // Proceed if we have everything
    if (questionDef && answers.whyNotSelected && answers.whyNotSelected.responses && answers.whyNotSelected.responses.length > 0) {
      // console.log("Looking at", answers.whyNotSelected); console.log("def",
      // questionDef);
      let choices = questionDef.choices;
      let resps = answers.whyNotSelected.responses;
      for (let j = 0; j < resps.length; j++) {
        if (resps[j] == 9999) {
          // OTHER
          let otherval = reasonsForLoss.find((vl) => {
            return vl.label === "__other__";
          });
          if (otherval == null) {
            otherval = {
              label: "__other__",
              shortLabel: ShortCleanupOnLabels("__other__"),
              count: 0,
              responses: []
            };
            reasonsForLoss.push(otherval);
          }
          otherval.count++;
          let otheroo = answers.whyNotSelected.other;
          if (typeof(otheroo) != "undefined" && otheroo.trim().length > 0) {
            if (!otherval.responses.find((vl) => {
              return vl == otheroo;
            })) {
              otherval
                .responses
                .push(otheroo.trim());
            }
          }
        } else {
          if (choices.length > resps[j]) {
            // Tally it up
            let val = choices[resps[j]];
            let existingEntry = reasonsForLoss.find((vl) => {
              return vl.label == val;
            });
            if (!existingEntry) {
              existingEntry = {
                label: val,
                shortLabel: ShortCleanupOnLabels(val),
                count: 0
              };
              reasonsForLoss.push(existingEntry);
            }
            existingEntry.count++;
          } else {
            // Option no longer exists??
            console.log("Option doesnt exist! hm..");
          }
        }
      }
      resultObject.reasonsForLoss = reasonsForLoss.sort((a, b) => {
        if (a.count < b.count) {
          return 1;
        } else if (a.count > b.count) {
          return -1;
        } else {
          return 0;
        }
      });
    }
  }

  // First, get info about the opportunities and approvals referenced by these
  // respondents
  var uniqueOpportunities = {};
  var uniqueApprovals = {};
  respondentArr.forEach((resp) => {
    if (resp.approval_guid && resp.approval_guid.trim().length > 0) {
      uniqueApprovals[resp.approval_guid] = true;
    }
  });
  uniqueApprovals = Object.keys(uniqueApprovals);
  uniqueApprovals = await Approval.GetListAsync(cfg, uniqueApprovals);
  uniqueApprovals.forEach((opp) => {
    if (opp.opportunity_id) {
      uniqueOpportunities[opp.opportunity_id] = true;
    }
  });
  uniqueOpportunities = Object.keys(uniqueOpportunities);
  uniqueOpportunities = await CRMOpportunities.GetListAsync(cfg, uniqueOpportunities);

  // Set up competitors object
  var competitorInfo = [];

  // Now make decisions about who actually won each opportunity
  for (let i = 0; i < uniqueOpportunities.length; i++) {
    // Quickreference the opportunity
    let theOpp = uniqueOpportunities[i];

    // Iterate over the surveys for this opportunity
    let surveysForOpp = await Survey.GetForOpportunityAndTypeAsync(cfg, theOpp.id, Survey.SURVEY_TYPES.PROSPECT);
    theOpp.surveys = surveysForOpp;

    // Get all the respondents for each opportunity
    var approvalsForOpp = uniqueApprovals.filter((apr) => {
      return apr.opportunity_id == theOpp.id;
    });
    theOpp.approvals = approvalsForOpp;
    var opportunityResps = respondentArr.filter((rep) => {
      return !!surveysForOpp.find((sv) => {
        return sv.guid == rep.survey_guid;
      });
    });
    theOpp.respondents = opportunityResps;

    // Now do the piping for each respondent and survey so we know what they
    // actually said
    opportunityResps.forEach((rep) => {
      let svForRep = surveysForOpp.find((sv) => {
        return sv.guid == rep.survey_guid;
      });
      if (svForRep) {
        rep.survey_model = svForRep.getPipedModel(rep);
      }
    });

    // Now find out who won according to each person
    let orgVotes = [];

    // Loop over each respondent and tally up the votes
    opportunityResps.forEach((resp) => {
      let vendorRankings = resp.answers.vendorRankings;
      // Only proceed if the user answered the question
      if (vendorRankings && vendorRankings.order && vendorRankings.order.length > 0) {
        let vendorQuestion = exter._locateQuestionObjectForName("vendorRankings", resp.survey_model.pages);
        let winningVendorId = vendorRankings.order[0];
        if (winningVendorId == 9999) {
          // OTHER
          let otherval = orgVotes.find((vl) => {
            return vl.label === "__other__";
          });
          if (otherval == null) {
            otherval = {
              label: "__other__",
              shortLabel: ShortCleanupOnLabels("__other__"),
              count: 0,
              responses: []
            };
            orgVotes.push(otherval);
          }
          otherval.count++;
          let otheroo = vendorRankings.other;
          if (typeof(otheroo) != "undefined" && otheroo.trim().length > 0) {
            if (!otherval.responses.find((vl) => {
              return vl == otheroo;
            })) {
              otherval
                .responses
                .push(otheroo.trim());
            }
          }
        } else {
          // REAL Tally it up
          let val = vendorQuestion.choices[winningVendorId];
          let existingEntry = orgVotes.find((vl) => {
            return vl.label == val;
          });
          if (!existingEntry) {
            existingEntry = {
              label: val,
              shortLabel: ShortCleanupOnLabels(val),
              count: 0
            };
            orgVotes.push(existingEntry);
          }
          existingEntry.count++;
        }
      }
    });

    // Sort orgVotes
    orgVotes = orgVotes.sort((a, b) => {
      if (a.count < b.count) {
        return 1;
      } else if (a.count > b.count) {
        return -1;
      } else {
        return 0;
      }
    });

    // Now we have a sorted list
    var winningVendor = orgVotes[0];
    winningVendor.Amount = theOpp.Amount;

    // Merge with the master list
    var existingItem = competitorInfo.find((og) => {
      return og.label == winningVendor.label;
    });
    if (!existingItem) {
      competitorInfo.push(winningVendor);
    } else {
      existingItem.Amount += winningVendor.Amount;
      // Is it "other"?
      if (existingItem.label == "__other__") {
        // Merge the responses
        for (let g = 0; g < winningVendor.responses.length; g++) {
          if (!existingItem.responses.find((rp) => {
            return rp == winningVendor.responses[g];
          })) {
            existingItem
              .responses
              .push(winningVendor.responses[g]);
          }
        }
      }
    }
  }

  // Sort the list
  competitorInfo = competitorInfo.sort((a, b) => {
    if (a.Amount < b.Amount) {
      return 1;
    } else if (a.Amount > b.Amount) {
      return -1;
    } else {
      return 0;
    }
  });

  // Now we find the reasons WHY people chose each vendor
  for (let h = 0; h < competitorInfo.length; h++) {
    let competitor = competitorInfo[h];

    // Find the responses that chose this competitor
    let competitorResps = respondentArr.filter((resp) => {
      let vendorRankings = resp.answers.vendorRankings;
      // Only proceed if the user answered the question
      if (vendorRankings && vendorRankings.order && vendorRankings.order.length > 0) {
        let vendorQuestion = exter._locateQuestionObjectForName("vendorRankings", resp.survey_model.pages);
        let winningVendorId = vendorRankings.order[0];
        if (winningVendorId == 9999) {
          // OTHER
          return competitor.label == "__other__";
        } else {
          let winningVendorName = vendorQuestion.choices[winningVendorId];
          return winningVendorName == competitor.label;
        }
      }
      return false;
    });

    // Only proceed if there ARE people, which there should be
    if (competitorResps.length > 0) {
      // Now create a holder for the reasons
      let sampleReasonsQuestion = exter._locateQuestionObjectForName("reasonsWhyWinnerChosen", competitorResps[0].survey_model.pages);
      let sampleReasons = JSON.parse(JSON.stringify(sampleReasonsQuestion.choices));

      // Now create a tally object for those choices
      var choicesTallyObject = sampleReasons.map((sr) => {
        return {label: sr, shortLabel: ShortCleanupOnLabels(sr), count: 0};
      });
      var otherReason = {
        label: "__other__",
        shortLabel: ShortCleanupOnLabels("__other__"),
        count: 0,
        responses: []
      };
      choicesTallyObject.push(otherReason);

      // Iterate over the respondents and tally up the results for this competitor
      for (let t = 0; t < competitorResps.length; t++) {
        let resp = competitorResps[t];

        // Find the answer to the reasons question
        let reasons = resp.answers.reasonsWhyWinnerChosen;
        if (reasons && reasons.responses && reasons.responses.length > 0) {
          for (let c = 0; c < reasons.responses.length; c++) {
            let reason = reasons.responses[c];
            if (reason == 9999) {
              otherReason.count++;
              // Merge the actual other reason
              if (reasons.other && reasons.other.trim().length > 0) {
                if (!otherReason.responses.find((rs) => {
                  return rs == reasons.other;
                })) {
                  otherReason
                    .responses
                    .push(reasons.other);
                }
              }
            } else {
              // Regular reason
              choicesTallyObject[reason].count++;
            }
          }
        }
      }

      // Sort the reasons by count
      choicesTallyObject = choicesTallyObject.sort((a, b) => {
        if (a.count < b.count) {
          return 1;
        } else if (a.count > b.count) {
          return -1;
        } else {
          return 0;
        }
      });

      // Assign it
      competitor.reasons = choicesTallyObject;
    }
  }

  // Assign it
  resultObject.losingDealsTo = competitorInfo;

  // Populate a tally object for sales process
  let sampleSalesProcessQuestion = exter._locateQuestionObjectForName("mostImportantVendorCriteria", respondentArr[0].survey_model.pages);
  let sampleSalesProcessFactors = JSON.parse(JSON.stringify(sampleSalesProcessQuestion.choices));

  // Now create a tally object for those choices
  var salesProcessImportTally = sampleSalesProcessFactors.map((sr) => {
    return {
      label: sr,
      shortLabel: ShortCleanupOnLabels(sr),
      importanceScore: 0,
      topRatedCount: 0,
      topRatedWithDetail: 0,
      ratingScore: 0
    };
  });
  var otherFactor = {
    label: "__other__",
    shortLabel: ShortCleanupOnLabels("__other__"),
    importanceScore: 0,
    topRatedCount: 0,
    topRatedWithDetail: 0,
    ratingScore: 0,
    responses: []
  };
  salesProcessImportTally.push(otherFactor);

  // Iterate the respondents and add the sales process rankings
  for (let s = 0; s < respondentArr.length; s++) {
    // Quickreference the respondent
    let resp = respondentArr[s];

    // Get the sales issue ranking question from the answers
    let mostImportantVendorCriteria = resp.answers.mostImportantVendorCriteria;
    if (mostImportantVendorCriteria && mostImportantVendorCriteria.order && mostImportantVendorCriteria.order.length > 0) {
      // Score in reverse order with the highest score going to the first item, and
      // so-on
      for (let y = 0; y < mostImportantVendorCriteria.order.length; y++) {
        let orderVal = mostImportantVendorCriteria.order[y];
        let scoreVal = mostImportantVendorCriteria.order.length - y - 1;
        let isInTop = y < 3;
        if (orderVal == 9999) {
          // OTHER
          otherFactor.importanceScore += scoreVal;
          otherFactor.topRatedCount += isInTop
            ? 1
            : 0;
          if (mostImportantVendorCriteria.other) {
            if (!otherFactor.responses.find((rp) => {
              return rp == mostImportantVendorCriteria.other;
            })) {
              otherFactor
                .responses
                .push(mostImportantVendorCriteria.other);
            }
          }
        } else {
          salesProcessImportTally[orderVal].topRatedCount += isInTop
            ? 1
            : 0;
          salesProcessImportTally[orderVal].importanceScore += scoreVal;
        }

        // If this is a top 3 then look at the next question
        if (isInTop) {
          let howWellInAreas = resp.answers.howWellInAreas;
          if (howWellInAreas && howWellInAreas.length > y) {
            // We have a ranking
            if (orderVal == 9999) {
              otherFactor.topRatedWithDetail++;
              otherFactor.ratingScore += howWellInAreas[y];
            } else {
              salesProcessImportTally[orderVal].topRatedWithDetail++;
              salesProcessImportTally[orderVal].ratingScore += howWellInAreas[y];
            }
          }
        }
      }
    }
  }

  // Now normalize the scores for salesProcessImportTally based on how much detail
  // we have
  for (let w = 0; w < salesProcessImportTally.length; w++) {
    // Quickreference
    let tallyObj = salesProcessImportTally[w];

    // If we have detail, then normalize
    if (tallyObj.topRatedWithDetail > 0) {
      tallyObj.ratingScore /= tallyObj.topRatedWithDetail;
    }
  }

  // Sort by importance
  salesProcessImportTally = salesProcessImportTally.sort((a, b) => {
    if (a.importanceScore < b.importanceScore) {
      return 1;
    } else if (a.importanceScore > b.importanceScore) {
      return -1;
    } else {
      return 0;
    }
  });

  // Assign it
  resultObject.salesProcess = salesProcessImportTally;

  // Now do overall perception scoring. Start with the slider ones.
  var freqRating = {
    label: "Frequency of contact",
    shortLabel: ShortCleanupOnLabels("Frequency of contact"),
    score: 0,
    count: 0
  };
  var responsivenessRating = {
    label: "Responsiveness",
    shortLabel: ShortCleanupOnLabels("Responsiveness"),
    score: 0,
    count: 0
  };
  var perceptionScores = [freqRating, responsivenessRating];

  // Now look at all the answers for this
  for (let s = 0; s < respondentArr.length; s++) {
    let resp = respondentArr[s];
    if (typeof(resp.answers.frequencyRating) != "undefined") {
      freqRating.score += resp.answers.frequencyRating;
      freqRating.count++;
    }
    if (typeof(resp.answers.responsivenessRating) != "undefined") {
      responsivenessRating.score += resp.answers.responsivenessRating;
      responsivenessRating.count++;
    }
  }

  // Normalize the two
  if (freqRating.count > 0) {
    freqRating.score /= freqRating.count;
    freqRating.score /= 10;
  }
  if (responsivenessRating.count > 0) {
    responsivenessRating.score /= responsivenessRating.count;
    responsivenessRating.score /= 10;
  }

  // Now make a second list for the others, which you will later combine with the first
  

  // Return the result array
  return resultObject;
};

/**
* The general report class
*/
var GeneralReport = function (cfg, orgid, startdate, enddate, cb) {
  RunReportAsync(cfg, orgid, startdate, enddate).then((res) => {
    cb(null, res);
  }).catch((err) => {
    cb(err);
  });
};

/**
* The general report class ASYNC
*/
var GeneralReportAsync = function (cfg, orgid, startdate, enddate) {
  return new Promise((resolve, reject) => {
    GeneralReport(cfg, orgid, startdate, enddate, (err, rep) => {
      if (err) {
        reject(err);
      } else {
        resolve(rep);
      }
    });
  });
};

// Expose it
module.exports = {
  GeneralReport,
  GeneralReportAsync
}